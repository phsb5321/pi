/**
 * Presentation-cost measurement (p3 N-series row) — THIN/LAZY PRESENTATIONS.
 *
 * Measures the whole-tree cost of the presentation leg at N presentations:
 *   phase A: 3 hosted engines (baseline)
 *   phase B: + 8 LAZY presentations (constructed, unrendered — target shape)
 *   phase C: + 8 eager attached presentations (rendered-equivalent contrast)
 *   phase D: + 16 more LAZY (24 lazy total) — the flat line check
 * Each phase prints a measured mem-probe advisory row (whole process tree,
 * the accepted instrument; measured values only, no estimates) and the
 * derived per-presentation marginal for p3's series. Synthetic engine only;
 * default OFF; zero paid calls.
 *
 * Run: node --experimental-strip-types packages/coding-agent/src/experimental/durable/shared-host-thin-measure.ts
 */
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
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
import { createLazyThinClient, createThinClient, type ThinClient } from "@earendil-works/pi-client";
import { createThinPresentation } from "./thin-presentation.ts";

function minimalEngine(identity: InProcessSessionIdentity): InProcessSessionEngine {
	const lines: string[] = [];
	let settle!: (error: Error | undefined) => void;
	const terminated = new Promise<Error | undefined>((resolve) => {
		settle = resolve;
	});
	const handlers: Record<string, (args: unknown[]) => unknown> = {
		submit: (args) => (lines.push(String(args[0] ?? "")), { ok: true }),
		observe: () => [...lines],
	};
	const attachment: InProcessSessionAttachment = {
		async invokeService(call) {
			const { member, args = [] } = call as unknown as { member: string; args?: unknown[] };
			const handler = handlers[member];
			if (handler === undefined) throw new Error(`minimal engine: no member ${member}`);
			return handler(args) as never;
		},
		async release(): Promise<void> {
			/* measurement engine holds nothing to release */
		},
	};
	return {
		identity,
		terminated,
		attach: async () => attachment,
		async close(): Promise<void> {
			settle(undefined);
		},
	};
}

const factory: InProcessEngineFactory = {
	async open(_metadata, identity) {
		return minimalEngine(identity);
	},
};

/** Measured whole-tree total (MiB) via mem-probe advisory, plus the raw print. */
function measure(label: string): number {
	const probeArgs = [fileURLToPath(new URL("../../../../../tools/mem-probe", import.meta.url))];
	const pidFile = join(tmpdir(), `shared-host-thin-measure-${process.pid}-${label.replace(/\W+/g, "-")}.pids`);
	writeFileSync(pidFile, `${process.pid}\n`);
	const run = spawnSync("python3", [...probeArgs, "--condition", "idle", "--advisory", "--seat-pids", pidFile], {
		encoding: "utf8",
	});
	unlinkSync(pidFile);
	const out = String(run.stdout ?? "");
	if (out.trim().length === 0) throw new Error(`mem-probe produced no measured output (status ${String(run.status)})`);
	let total = Number.NaN;
	for (const line of out.split("\n")) {
		process.stdout.write(`mem-probe[${label}]: ${line}\n`);
		// Seat row: ROOT AGE NPROC PSS SWAP TOTAL PROOF...
		const seatRow = /^\d+\s+\d+m\s+\d+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s+\S+/.exec(line.trim());
		if (seatRow !== null) total = Number(seatRow[1]);
	}
	if (!Number.isFinite(total)) throw new Error(`mem-probe[${label}]: no seat row parsed`);
	return total;
}

/**
 * PRESENTATION-COST ROW (100x tier): the presentation layer alone (stub legs —
 * no engine, no provider) across N presentations: constructed (unpainted),
 * painted, attached. The tier target is <=2 MiB/presentation (100x),
 * <=6 MiB = 10x. Measured mem-probe whole-tree only; no RAM-acceptance claim.
 */
async function runPresentations(): Promise<number> {
	const n = Number(process.env.THIN_PRESENTATION_N ?? 24);
	const baseline = measure("P0:empty");
	process.stdout.write(`row P0 empty process: ${baseline.toFixed(1)} MiB\n`);
	// R-A win20 shape: deterministic worked-class messages (~1.5 KiB each),
	// observed through the bounded client-observation contract (observe).
	const message = (index: number) =>
		`## Message ${index}\n\n- item one with **bold** and \`code\` spans\n- item two of the worked-class fixture\n\n\`\`\`ts\nconst value${index} = compute(${index});\n\`\`\`\n\nThe prose paragraph for message ${index} with enough text to stand in for a real worked entry.`;
	const stub = (id: string) => {
		const transcript = Array.from({ length: 20 }, (_unused, index) => message(index));
		return {
			sessionId: id,
			submit: async () => undefined,
			observe: async (): Promise<readonly string[]> => [...transcript],
			close: async () => undefined,
		};
	};
	const presentations = Array.from({ length: n }, (_unused, index) =>
		createThinPresentation({ create: () => stub(`p${index}`), pollMs: 0 }),
	);
	const unpainted = measure(`P1:${n}-created-unpainted`);
	process.stdout.write(
		`row P1 ${n} created (unpainted): ${unpainted.toFixed(1)} MiB (marginal ${((unpainted - baseline) / n).toFixed(2)} MiB/presentation)\n`,
	);
	for (const presentation of presentations) presentation.component.render(120);
	const painted = measure(`P2:${n}-painted`);
	process.stdout.write(
		`row P2 ${n} painted: ${painted.toFixed(1)} MiB (marginal ${((painted - unpainted) / n).toFixed(2)} MiB/presentation added by paint)\n`,
	);
	for (const presentation of presentations) await presentation.submit("cost row");
	const attached = measure(`P3:${n}-attached`);
	process.stdout.write(
		`row P3 ${n} attached+win20 painted: ${attached.toFixed(1)} MiB (marginal ${((attached - painted) / n).toFixed(2)} MiB/presentation added by attach)\n`,
	);
	const perPresentation = (attached - baseline) / n;
	const tier = perPresentation <= 2 ? "100x" : perPresentation <= 6 ? "10x" : "below-10x";
	const settledSlope = (attached - unpainted) / n;
	process.stdout.write(
		`PRESENTATION-COST ROW (whole-tree census, measured only, win20 shape): ${perPresentation.toFixed(2)} MiB/presentation end-to-end at N=${n}; settled slope ${settledSlope.toFixed(2)} MiB/presentation (R-A measured band 0.36–0.59) → ${tier} tier (target ≤2 MiB 100x / ≤6 MiB 10x).\n`,
	);
	for (const presentation of presentations) presentation.dispose();
	return 0;
}

async function run(): Promise<number> {
	const runtime = createInProcessRuntime(factory, { maxSessions: 32 });
	const sessionIds = ["m1", "m2", "m3"];
	const handles = new Map<string, Awaited<ReturnType<typeof runtime.host.openSession>>>();
	for (const id of sessionIds) handles.set(id, await runtime.host.openSession({ id }, {} as never));

	const baseline = measure("A:3-engines");
	process.stdout.write(`row A baseline (3 engines): ${baseline.toFixed(1)} MiB\n`);

	// B: lazy presentations — constructed, NEVER used (no connect, no attach).
	const lazy: ThinClient[] = [];
	for (let index = 0; index < 8; index++) {
		lazy.push(
			createLazyThinClient({
				sessionId: sessionIds[index % 3]!,
				connect: () => Promise.reject(new Error("unused")),
			}),
		);
	}
	const lazyPhase = measure("B:+8-lazy-unrendered");
	process.stdout.write(
		`row B +8 lazy unrendered: ${lazyPhase.toFixed(1)} MiB (marginal ${(lazyPhase - baseline).toFixed(2)} MiB/presentation)\n`,
	);

	// C: eager attached presentations (rendered-equivalent contrast).
	const eager: ThinClient[] = [];
	for (let index = 0; index < 8; index++) {
		const id = sessionIds[index % 3]!;
		const attachment = await handles.get(id)!.attachClient({} as never);
		const invoke = (call: { member: string; args?: unknown[] }) =>
			attachment.invokeService(call as never, () => undefined, {} as never) as Promise<unknown>;
		eager.push(createThinClient(id, invoke));
	}
	await eager[0]!.submit("warm");
	const eagerPhase = measure("C:+8-eager-attached");
	process.stdout.write(
		`row C +8 eager attached: ${eagerPhase.toFixed(1)} MiB (marginal ${((eagerPhase - lazyPhase) / 8).toFixed(2)} MiB/presentation)\n`,
	);

	// D: more lazy (flat-line check).
	for (let index = 0; index < 16; index++) {
		lazy.push(
			createLazyThinClient({
				sessionId: sessionIds[index % 3]!,
				connect: () => Promise.reject(new Error("unused")),
			}),
		);
	}
	const flat = measure("D:+16-lazy-unrendered");
	process.stdout.write(
		`row D +16 lazy unrendered: ${flat.toFixed(1)} MiB (marginal ${((flat - eagerPhase) / 16).toFixed(2)} MiB/presentation)\n`,
	);

	process.stdout.write(
		`PRESENTATION-COST ROW (p3 N-series, whole-tree census includes this leg): ` +
			`lazy-unrendered ≈ ${((lazyPhase - baseline) / 8).toFixed(2)} MiB/each (flat-line ${((flat - eagerPhase) / 16).toFixed(2)}), ` +
			`eager-attached ≈ ${((eagerPhase - lazyPhase) / 8).toFixed(2)} MiB/each at N=8.\n`,
	);
	await runtime.control.shutdown({} as never);
	void lazy;
	return 0;
}

const entry = process.env.THIN_PRESENTATION_ROW === "1" ? runPresentations() : run();
entry.then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(
			`shared-host-thin-measure: FAIL ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(3);
	},
);
