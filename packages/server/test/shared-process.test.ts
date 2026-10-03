import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { describe, expect, it, vi } from "vitest";
import {
	createSharedProcessHost,
	SharedProcessCapacityError,
	SharedProcessClosingError,
	type SharedProcessPolicy,
	SharedProcessPolicyError,
	sharedProcessSnapshot,
} from "../src/shared-process.ts";
import type { RoutedSessionAttachment, RoutedSessionHandle, ServerHost, SessionMetadata } from "../src/types.ts";

// ── fakes: the smallest ServerHost that records what the decorator does ──────
// (no child_process/worker_threads anywhere in the slice: in-process by
// construction, so occupied-seat replacement is unreachable — the regression
// pins that the inner host is the decorator's only interaction.)

interface FakeLeaseRecord {
	calls: number;
	released: number;
	contexts: Context[];
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeContext(marker: string): Context {
	return { marker } as unknown as Context;
}

/** Flush microtasks until the predicate holds (deferred inner opens register gates one tick later). */
async function flushUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
	expect(predicate()).toBe(true);
}

class FakeHandle implements RoutedSessionHandle {
	/** Upstream contract: RESOLVES with an Error on crash, undefined on close. */
	readonly terminated: Promise<Error | undefined>;
	private resolveTerminated!: (error: Error | undefined) => void;
	readonly record: FakeLeaseRecord = { calls: 0, released: 0, contexts: [] };

	closedCount = 0;
	attachCount = 0;
	closeCalls = 0;
	/** When true, close() parks on a deferred (the deferred-close race). */
	holdClose = false;
	readonly closeGates: Deferred[] = [];
	/** When set, close() rejects (capacity must stay held). */
	failCloseWith: Error | undefined;

	constructor() {
		this.terminated = new Promise<Error | undefined>((resolve) => {
			this.resolveTerminated = resolve;
		});
	}

	terminate(error: Error | undefined): void {
		this.resolveTerminated(error);
	}

	attachClient(context: Context): RoutedSessionAttachment {
		this.attachCount++;
		this.record.contexts.push(context);
		const record = this.record;
		return {
			async invokeService(
				_call: ServiceCall,
				_publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => unknown,
				context: Context,
			): Promise<JsonValue | undefined> {
				record.calls++;
				record.contexts.push(context);
				return `lease:${String((context as unknown as { marker: string }).marker)}` as unknown as JsonValue;
			},
			async release(_context: Context): Promise<void> {
				record.released++;
			},
		};
	}

	async close(_context: Context): Promise<void> {
		this.closeCalls++;
		if (this.failCloseWith) throw this.failCloseWith;
		if (this.holdClose) {
			const gate = deferred();
			this.closeGates.push(gate);
			await gate.promise;
		}
		this.closedCount++;
		this.resolveTerminated(undefined);
	}
}

interface FakeHost extends ServerHost<SessionMetadata> {
	readonly opened: Map<string, FakeHandle>;
	readonly openOrder: string[];
	readonly gates: Deferred[];
	gateOpens: boolean;
}

function makeHost(options: { gateOpens?: boolean } = {}): FakeHost {
	const opened = new Map<string, FakeHandle>();
	const openOrder: string[] = [];
	const gates: Deferred[] = [];
	const serverServices = {
		attachClient: () => {
			throw new Error("not used in this regression");
		},
	};
	const host: FakeHost = {
		serverServices: serverServices as never,
		opened,
		openOrder,
		gates,
		gateOpens: options.gateOpens ?? false,
		async resolveSession(sessionId: string): Promise<SessionMetadata> {
			return { id: sessionId };
		},
		async openSession(metadata: SessionMetadata): Promise<RoutedSessionHandle> {
			openOrder.push(metadata.id);
			if (host.gateOpens) {
				const gate = deferred();
				gates.push(gate);
				await gate.promise;
			}
			const handle = new FakeHandle();
			opened.set(metadata.id, handle);
			return handle;
		},
	};
	return host;
}

// ── the regression ───────────────────────────────────────────────────────────

function makeRetiringShared(onBeforeRetire: () => Promise<void>): {
	host: FakeHost;
	errors: unknown[];
	shared: ReturnType<typeof createSharedProcessHost>;
} {
	const host = makeHost();
	const errors: unknown[] = [];
	const shared = createSharedProcessHost(host, {
		maxWorkers: 4,
		retireAfterIdleMs: 50,
		isHarnessIdle: () => true,
		onBeforeRetire,
		onError: (error) => errors.push(error),
	});
	return { host, errors, shared };
}

describe("shared-process worker slice (opt-in, bounded, retiring)", () => {
	it("is opt-in composition: opens exactly through the inner host and caps workers", async () => {
		const host = makeHost();
		const refused: string[] = [];
		const admitted: string[] = [];
		const policy: SharedProcessPolicy = {
			maxWorkers: 2,
			onWorkerOpen: (info) => admitted.push(info.identity.sessionId),
			onWorkerRefused: (refusedInfo) => refused.push(refusedInfo.sessionId),
		};
		const shared = createSharedProcessHost(host, policy);

		await shared.openSession({ id: "s1" }, makeContext("open-1"));
		await shared.openSession({ id: "s2" }, makeContext("open-2"));
		await expect(shared.openSession({ id: "s3" }, makeContext("open-3"))).rejects.toBeInstanceOf(
			SharedProcessCapacityError,
		);

		expect(host.openOrder).toEqual(["s1", "s2"]);
		expect(admitted).toEqual(["s1", "s2"]);
		expect(refused).toEqual(["s3"]);
	});

	it("isolates per-worker state and never pools contexts across sessions", async () => {
		const host = makeHost();
		const shared = createSharedProcessHost(host, { maxWorkers: 8 });
		const openA = makeContext("open-a");
		const openB = makeContext("open-b");
		const handleA = await shared.openSession({ id: "a" }, openA);
		const handleB = await shared.openSession({ id: "b" }, openB);

		const callA = makeContext("call-a");
		const callB = makeContext("call-b");
		const leaseA = await handleA.attachClient(makeContext("attach-a"));
		const leaseB = await handleB.attachClient(makeContext("attach-b"));
		const resultA = await leaseA.invokeService({} as ServiceCall, () => undefined, callA);
		const resultB = await leaseB.invokeService({} as ServiceCall, () => undefined, callB);

		expect(resultA).toBe("lease:call-a");
		expect(resultB).toBe("lease:call-b");
		const recA = host.opened.get("a")!.record;
		const recB = host.opened.get("b")!.record;
		expect(recA.calls).toBe(1);
		expect(recB.calls).toBe(1);
		expect(recA.contexts).toContain(callA);
		expect(recA.contexts).not.toContain(callB);
		expect(recB.contexts).toContain(callB);
		expect(recB.contexts).not.toContain(callA);

		await leaseA.release(makeContext("release-a"));
		expect(recB.released).toBe(0);
		expect(recA.released).toBe(1);
		expect(sharedProcessSnapshot([])).toEqual({ workers: 0, demand: 0, inFlight: 0 });
	});

	it("retires idle workers within the bounded window and respects demand + harness activity", async () => {
		vi.useFakeTimers();
		try {
			const host = makeHost();
			const events: string[] = [];
			const shared = createSharedProcessHost(host, {
				maxWorkers: 8,
				retireAfterIdleMs: 50,
				isHarnessIdle: (identity) => identity.sessionId !== "busy-harness",
				onBeforeRetire: (info) => {
					events.push(`before:${info.identity.sessionId}`);
				},
				onAfterRetire: (info) => {
					events.push(`after:${info.identity.sessionId}`);
				},
			});

			const idle = await shared.openSession({ id: "idle" }, makeContext("open-idle"));
			const attached = await shared.openSession({ id: "attached" }, makeContext("open-attached"));
			const harness = await shared.openSession({ id: "busy-harness" }, makeContext("open-harness"));
			const lease = await attached.attachClient(makeContext("attach"));

			await vi.advanceTimersByTimeAsync(100);
			// The initially-idle worker retired (retirement schedules at open).
			expect(host.opened.get("idle")!.closedCount).toBe(1);
			expect(events).toEqual(["before:idle", "after:idle"]);
			expect(host.opened.get("attached")!.closedCount).toBe(0);
			expect(host.opened.get("busy-harness")!.closedCount).toBe(0);

			// Releasing the lease schedules retirement for "attached".
			await lease.release(makeContext("release"));
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("attached")!.closedCount).toBe(1);
			expect(host.opened.get("busy-harness")!.closedCount).toBe(0);

			// Expected close (retirement) resolves terminated with undefined.
			await expect(idle.terminated).resolves.toBeUndefined();
			await harness.close(makeContext("close-harness"));
			await expect(harness.terminated).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps crash parity: unexpected termination RESOLVES the error and frees only that slot", async () => {
		const host = makeHost();
		const shared = createSharedProcessHost(host, { maxWorkers: 8 });
		const handleA = await shared.openSession({ id: "a" }, makeContext("open-a"));
		await shared.openSession({ id: "b" }, makeContext("open-b"));

		const innerA = host.opened.get("a")!;
		const crash = new Error("worker crash");
		innerA.terminate(crash);
		// Upstream contract: terminated RESOLVES with the Error on crash.
		await expect(handleA.terminated).resolves.toBe(crash);

		// Only A's slot is gone; B stays hosted and attachable.
		const handleB = await shared.openSession({ id: "b" }, makeContext("reopen-b"));
		const leaseB = await handleB.attachClient(makeContext("attach-b"));
		expect(host.opened.get("b")!.attachCount).toBe(1);
		await leaseB.release(makeContext("release-b"));

		// Reopen A: the inner host opens again (generation advances).
		const reopened = await shared.openSession({ id: "a" }, makeContext("reopen-a"));
		const leaseA2 = await reopened.attachClient(makeContext("attach-a2"));
		await leaseA2.release(makeContext("release-a2"));
		expect(host.openOrder.filter((id) => id === "a").length).toBe(2);
	});

	it("close() is an expected close (terminated resolves undefined) and frees the slot", async () => {
		const host = makeHost();
		const shared = createSharedProcessHost(host, { maxWorkers: 4 });
		const handle = await shared.openSession({ id: "s" }, makeContext("open"));
		await handle.close(makeContext("close"));
		expect(host.opened.get("s")!.closedCount).toBe(1);
		await expect(handle.terminated).resolves.toBeUndefined();
		await shared.openSession({ id: "s2" }, makeContext("open-2"));
		await shared.openSession({ id: "s3" }, makeContext("open-3"));
		await shared.openSession({ id: "s4" }, makeContext("open-4"));
		expect(host.openOrder).toEqual(["s", "s2", "s3", "s4"]);
	});

	it("holds the cap under concurrent delayed opens (reservation before await)", async () => {
		const host = makeHost({ gateOpens: true });
		const shared = createSharedProcessHost(host, { maxWorkers: 2 });

		const p1 = shared.openSession({ id: "c1" }, makeContext("open-1"));
		const p2 = shared.openSession({ id: "c2" }, makeContext("open-2"));
		const p3 = shared.openSession({ id: "c3" }, makeContext("open-3"));

		// The third concurrent open was refused at admission (no await between
		// capacity check and reservation), while the first two are still open.
		await expect(p3).rejects.toBeInstanceOf(SharedProcessCapacityError);
		await flushUntil(() => host.gates.length === 2);

		// Release the delayed opens: exactly two inner opens happened.
		host.gates.forEach((gate) => {
			gate.resolve();
		});
		await Promise.all([p1, p2]);
		expect(host.openOrder).toEqual(["c1", "c2"]);
	});

	it("shares one inner open across concurrent same-session opens and cleans up on failure", async () => {
		const host = makeHost({ gateOpens: true });
		const shared = createSharedProcessHost(host, { maxWorkers: 4 });

		const a1 = shared.openSession({ id: "same" }, makeContext("open-1"));
		const a2 = shared.openSession({ id: "same" }, makeContext("open-2"));
		await flushUntil(() => host.gates.length === 1);
		host.gates.forEach((gate) => {
			gate.resolve();
		});
		const [h1, h2] = await Promise.all([a1, a2]);
		expect(host.openOrder).toEqual(["same"]);
		expect(h1).not.toBe(h2);

		// Failure cleanup: a failed pending open releases its reservation.
		const host2 = makeHost({ gateOpens: true });
		const shared2 = createSharedProcessHost(host2, { maxWorkers: 1 });
		const failing = shared2.openSession({ id: "boom" }, makeContext("open"));
		await flushUntil(() => host2.gates.length === 1);
		host2.gates.forEach((gate) => {
			gate.reject(new Error("inner open failed"));
		});
		await expect(failing).rejects.toThrow("inner open failed");
		// Capacity is available again (reservation cleaned up).
		const host2Next = shared2.openSession({ id: "next" }, makeContext("open-next"));
		await flushUntil(() => host2.gates.length === 2);
		host2.gates.forEach((gate) => {
			gate.resolve();
		});
		await expect(host2Next).resolves.toBeDefined();
	});

	it("rejects invalid policy values (Infinity/NaN/fraction/negative) and requires isHarnessIdle for retirement", () => {
		const host = makeHost();
		for (const maxWorkers of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createSharedProcessHost(host, { maxWorkers })).toThrow(SharedProcessPolicyError);
		}
		for (const retireAfterIdleMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() =>
				createSharedProcessHost(host, { maxWorkers: 4, retireAfterIdleMs, isHarnessIdle: () => true }),
			).toThrow(SharedProcessPolicyError);
		}
		expect(() =>
			createSharedProcessHost(host, { maxWorkers: 4, retireAfterIdleMs: 12.5, isHarnessIdle: () => true }),
		).not.toThrow();
		// Retirement without host harness knowledge is refused outright.
		expect(() => createSharedProcessHost(host, { maxWorkers: 4, retireAfterIdleMs: 50 })).toThrow(
			SharedProcessPolicyError,
		);
		expect(() => createSharedProcessHost(host, { maxWorkers: 4 })).not.toThrow();
		// Node clamps timer delays above 2^31-1 to 1ms: reject instead of
		// surprise immediate retirement.
		expect(() =>
			createSharedProcessHost(host, { maxWorkers: 4, retireAfterIdleMs: 2_147_483_647, isHarnessIdle: () => true }),
		).not.toThrow();
		expect(() =>
			createSharedProcessHost(host, { maxWorkers: 4, retireAfterIdleMs: 2_147_483_648, isHarnessIdle: () => true }),
		).toThrow(SharedProcessPolicyError);
	});

	it("re-arms the idle timer when the harness is busy and retires once it goes idle", async () => {
		vi.useFakeTimers();
		try {
			const host = makeHost();
			const harnessBusy: Record<string, boolean> = { a: true, b: false };
			let hookCallsB = 0;
			const shared = createSharedProcessHost(host, {
				maxWorkers: 4,
				retireAfterIdleMs: 50,
				isHarnessIdle: (identity) => !harnessBusy[identity.sessionId],
				onBeforeRetire: (info) => {
					if (info.identity.sessionId === "b" && ++hookCallsB === 1) harnessBusy.b = true;
				},
			});

			await shared.openSession({ id: "a" }, makeContext("open-a"));
			await shared.openSession({ id: "b" }, makeContext("open-b"));

			// a: harness busy at timer fire → bail at the entry gate → re-armed.
			// b: entry idle, hook flips the harness busy → post-hook bail → re-armed.
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("a")!.closedCount).toBe(0);
			expect(host.opened.get("b")!.closedCount).toBe(0);
			expect(hookCallsB).toBe(1);

			// Still busy: every window re-arms, nothing retires.
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("a")!.closedCount).toBe(0);
			expect(host.opened.get("b")!.closedCount).toBe(0);

			// Harnesses go idle without any attachment event: the re-armed
			// timers retire both within one window.
			harnessBusy.a = false;
			harnessBusy.b = false;
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("a")!.closedCount).toBe(1);
			expect(host.opened.get("b")!.closedCount).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails attach closed once close begins and releases capacity only on success or termination", async () => {
		const host = makeHost();
		const hookGate = deferred();
		const shared = createSharedProcessHost(host, {
			maxWorkers: 4,
			retireAfterIdleMs: 50,
			isHarnessIdle: () => true,
			onBeforeRetire: () => hookGate.promise,
		});

		vi.useFakeTimers();
		try {
			const handle = await shared.openSession({ id: "closing" }, makeContext("open"));
			const inner = host.opened.get("closing")!;
			inner.holdClose = true;
			await vi.advanceTimersByTimeAsync(100); // retire entered the hook
			hookGate.resolve();
			// The hook completed and the deferred close has begun.
			await flushUntil(() => inner.closeCalls === 1);
			// Fail closed: no client receives a closing worker.
			await expect(handle.attachClient(makeContext("attach-late"))).rejects.toBeInstanceOf(
				SharedProcessClosingError,
			);
			// The deferred close completes: expected close, slot released.
			inner.closeGates.forEach((gate) => {
				gate.resolve();
			});
			await expect(handle.terminated).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps capacity when close rejects and frees it only on actual termination", async () => {
		const host = makeHost();
		const shared = createSharedProcessHost(host, { maxWorkers: 1 });
		const handle = await shared.openSession({ id: "stuck" }, makeContext("open"));
		const inner = host.opened.get("stuck")!;
		inner.failCloseWith = new Error("close failed");

		await expect(handle.close(makeContext("close"))).rejects.toThrow("close failed");
		// Capacity is still held: the inner worker is live and un-closed.
		await expect(shared.openSession({ id: "other" }, makeContext("open-other"))).rejects.toBeInstanceOf(
			SharedProcessCapacityError,
		);
		// Actual termination frees the slot (the one release path).
		inner.terminate(undefined);
		await handle.terminated;
		await expect(shared.openSession({ id: "other" }, makeContext("open-other-2"))).resolves.toBeDefined();
	});

	it("blocks retirement while an attach is in flight and keeps timer failures handled", async () => {
		vi.useFakeTimers();
		try {
			const gate = deferred();
			const { host, errors, shared } = makeRetiringShared(() => gate.promise);

			const handle = await shared.openSession({ id: "racy" }, makeContext("open"));
			await vi.advanceTimersByTimeAsync(100); // retirement entered onBeforeRetire (awaiting gate)
			const lease = await handle.attachClient(makeContext("attach")); // attach lands mid-retirement
			gate.resolve();
			await vi.advanceTimersByTimeAsync(0);
			// Retirement aborted: the worker stays hosted.
			expect(host.opened.get("racy")!.closedCount).toBe(0);

			// Timer-hook failures are reported, never unhandled rejections.
			await lease.release(makeContext("release"));
			gate.reject(new Error("hook boom")); // already-resolved gate: no-op; use a fresh failure below
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("racy")!.closedCount).toBe(1); // retired normally on the second window
			expect(errors).toEqual([]);
		} finally {
			vi.useRealTimers();
		}

		// Explicit failure path: a rejecting onBeforeRetire keeps the worker and reports.
		vi.useFakeTimers();
		try {
			const { host, errors, shared } = makeRetiringShared(() => Promise.reject(new Error("hook boom")));
			const handle = await shared.openSession({ id: "boom" }, makeContext("open"));
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("boom")!.closedCount).toBe(0);
			expect(errors.map((e) => (e as Error).message)).toEqual(["hook boom"]);
			// The worker is still usable and can retire later.
			const lease = await handle.attachClient(makeContext("attach"));
			await lease.release(makeContext("release"));
			vi.advanceTimersByTime(100);
			await vi.advanceTimersByTimeAsync(100);
			expect(host.opened.get("boom")!.closedCount).toBe(0); // hook keeps failing; worker retained
			expect(errors.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
