/**
 * BOUNDED EXECUTABLE ACCEPTANCE (pD, PORT-PI-1229) — client presentation
 * acceptance for the thin-presentation slice.
 *
 * On an ACTUALLY RENDERED, TTY-attached presentation (existing pi-tui
 * widgets over ProcessTerminal), driven by real PTY keystrokes, it exercises:
 *   first visible input -> stream/state -> cancel -> disconnect -> re-attach
 * and records exact imported source/artifact/PID topology.
 *
 * STATUS SEPARATION (non-negotiable): the run prints `source` topology,
 * `LIVE-not-ACCEPTED` status (p4 immutable product PENDING), and
 * `engine-binding: STANDIN` — the real durable view/controller adapter is a
 * PUBLISHED transition owned by the durable-harness slice (main.ts:17
 * `runDurableTui(durable.view, durable.controller, …)`); a fake engine
 * fixture is NOT acceptance. 100x remains UNPROVEN (p3's offhost lane).
 *
 * Run (one bounded launch):
 *   node --experimental-strip-types packages/coding-agent/src/experimental/durable/thin-presentation-acceptance.ts
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createInProcessRuntime,
	type InProcessEngineFactory,
	type InProcessSessionAttachment,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
} from "@earendil-works/pi-server";
import { createThinClient, type ThinClient } from "@earendil-works/pi-client";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { Context, JsonValue } from "@earendil-works/chord";
import { createThinPresentation } from "./thin-presentation.ts";

class StandInEngine implements InProcessSessionEngine {
	readonly identity: InProcessSessionIdentity;
	readonly terminated: Promise<Error | undefined>;
	private readonly transcript: string[] = [];
	private readonly attachment: InProcessSessionAttachment;
	private settle!: (error: Error | undefined) => void;

	constructor(identity: InProcessSessionIdentity) {
		this.identity = identity;
		this.terminated = new Promise<Error | undefined>((resolve) => {
			this.settle = resolve;
		});
		const self = this;
		this.attachment = {
			async invokeService(call) {
				const member = String((call as { member?: unknown }).member ?? "");
				const raw = (call as { args?: unknown[] }).args;
				const args = Array.isArray(raw) ? raw : [];
				if (member === "submit") {
					self.transcript.push(String(args[0] ?? ""));
					return { ok: true };
				}
				if (member === "observe") return [...self.transcript];
				throw new Error(`StandInEngine: no member ${member}`);
			},
			async release(): Promise<void> {
				/* nothing held */
			},
		};
	}

	async attach(): Promise<InProcessSessionAttachment> {
		return this.attachment;
	}

	async close(): Promise<void> {
		this.settle(undefined);
	}
}

function printTopology(): void {
	const here = import.meta.url;
	const resolve = (specifier: string): string => {
		try {
			return import.meta.resolve(specifier);
		} catch {
			return "UNRESOLVED";
		}
	};
	process.stdout.write(`[topology] presentation-pid=${process.pid}\n`);
	process.stdout.write(
		`[topology] source thin-presentation=${fileURLToPath(new URL("./thin-presentation.ts", here))}\n`,
	);
	for (const specifier of [
		"@earendil-works/pi-client",
		"@earendil-works/pi-server",
		"@earendil-works/pi-tui",
		"@earendil-works/chord",
		"@earendil-works/pi-protocol",
	]) {
		process.stdout.write(`[topology] import ${specifier} -> ${resolve(specifier)}\n`);
	}
}

async function inner(): Promise<void> {
	const factory: InProcessEngineFactory = {
		async open(_metadata, identity) {
			return new StandInEngine(identity);
		},
	};
	const runtime = createInProcessRuntime(factory, { maxSessions: 4 });
	const handle = await runtime.host.openSession({ id: "accept-1" }, {} as never);
	const attachment = await handle.attachClient({} as never);
	const invoke = (call: { member: string; args?: unknown[] }) =>
		attachment.invokeService(
			{ serviceId: "canary.session", member: call.member, args: (call.args ?? []) as JsonValue[] },
			() => undefined,
			{} as Context,
		) as Promise<unknown>;
	const leg: ThinClient = createThinClient("accept-1", invoke);

	printTopology();
	process.stdout.write("[status] mode=LIVE-not-ACCEPTED — p4 immutable product PENDING\n");
	process.stdout.write(
		"[status] engine-binding=STANDIN — published transition owns the real durable view/controller adapter (main.ts:17 runDurableTui)\n",
	);
	process.stdout.write("[status] 100x=UNPROVEN — RAM N-series is p3's admitted offhost lane\n");

	// Demand attachment lives in the presentation: the leg is created on first
	// visible use, and re-created after disconnect (re-attach on demand).
	let creations = 0;
	const presentation = createThinPresentation({
		create: () => {
			creations += 1;
			return creations === 1 ? leg : createThinClient("accept-1", invoke);
		},
		onState: (lines) => {
			process.stdout.write(`[thin] state n=${lines.length}\n`);
		},
		pollMs: 250,
	});

	const tui = new TuiMainScreen(new ProcessTerminal(), false, tmpdir());
	tui.addChild(presentation.component);
	tui.setFocus(presentation.component as never);
	tui.start();
	process.stdout.write("[acceptance] ready\n");

	const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	await wait(600);
	// The PTY driver types into the rendered input widget.
	const deadline = Date.now() + 30_000;
	const watcher = setInterval(() => {
		const done = presentation.status().attachedGeneration >= 2 && presentation.status().cancelled;
		if (done || Date.now() > deadline) {
			clearInterval(watcher);
			process.stdout.write(done ? "[acceptance] FLOW-COMPLETE\n" : "[acceptance] TIMEOUT\n");
			tui.stop();
			presentation.dispose();
			void runtime.control.shutdown({} as never).then(() => process.exit(done ? 0 : 3));
		}
	}, 250);
	watcher.unref();
}

function outer(): void {
	const self = fileURLToPath(import.meta.url);
	const typescript = join(process.env.PI_SCRATCH_DIR ?? tmpdir(), `thin-presentation-acceptance-${process.pid}.log`);
	const child = spawn("script", ["-qec", 'exec node --experimental-strip-types "$THIN_ACCEPT_SELF"', typescript], {
		env: { ...process.env, THIN_ACCEPT_INNER: "1", THIN_ACCEPT_SELF: self },
		stdio: ["pipe", "inherit", "inherit"],
	});
	const steps: Array<[number, string]> = [
		[1200, "hello\r"], // first visible input -> submit + state
		[1500, "\x1b"], // cancel (Esc)
		[800, "exit\r"], // disconnect (printable command; Ctrl-D/Ctrl-X mapped in the widget too)
		[1200, "again\r"], // re-attach on demand + submit + state
		[1500, "\x1b"], // cancel again => generation 2 + cancelled = flow complete
	];
	let at = 800;
	for (const [delay, keys] of steps) {
		at += delay;
		setTimeout(() => child.stdin.write(keys), at);
	}
	child.on("exit", async (code) => {
		const output = await readFile(typescript, "utf8").catch(() => "");
		// Presence + semantic ordering (stdout polls interleave with paint
		// frames in the raw stream, so frame-order markers are checked by
		// presence; the generation markers share one channel and must order).
		const markers = [
			"[thin] presentation ready",
			"[thin] attach demand (generation 1)",
			"[thin] submit visible: hello",
			"[thin] state n=1",
			"[thin] cancel",
			"[thin] disconnect",
			"[thin] attach demand (generation 2)",
			"[thin] submit visible: again",
			"[thin] state n=2",
			"[acceptance] FLOW-COMPLETE",
		];
		for (const marker of markers) {
			if (!output.includes(marker)) {
				process.stdout.write(`[acceptance] MISSING marker: ${marker}\n`);
				process.exit(3);
			}
		}
		const first = output.indexOf("[thin] attach demand (generation 1)");
		const second = output.indexOf("[thin] attach demand (generation 2)");
		if (first === -1 || second <= first) {
			process.stdout.write("[acceptance] BAD generation ordering (re-attach not after first attach)\n");
			process.exit(3);
		}
		const topologyLine = /\[topology\] presentation-pid=(\d+)/.exec(output)?.[1] ?? "unknown";
		process.stdout.write(`[census] presentation-pid=${topologyLine} driver-pid=${process.pid} code=${code}\n`);
		process.stdout.write("[census] topology + status lines above are the exact source/artifact/PID record\n");
		process.stdout.write("thin-presentation-acceptance: ALL PASS (LIVE-not-ACCEPTED; see status lines)\n");
		process.exit(0);
	});
}

if (process.env.THIN_ACCEPT_INNER === "1") {
	void inner();
} else if (process.stdout.isTTY) {
	// Direct PTY invocation: run the presentation without the driver.
	void inner();
} else {
	outer();
}
