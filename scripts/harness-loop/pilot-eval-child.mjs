// Pilot candidate evaluator child. Trusted code only; the candidate never runs in this Node process.
// stdin: {"src": string, "inputs": [[a, b], ...]}. Held-out expectations are never sent here.
// stdout: exactly one JSON line {"schema":"pilot-eval-v1","results":[{ok,value}|{ok:false,error}]}
// or {"schema":"pilot-eval-v1","rejected": reason}. The host compares values; this child decides nothing.
// The candidate is evaluated in a fresh QuickJS VM: no process, require, fs, fetch or module loader,
// a 16 MB memory limit and a 2 s interrupt per step.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const emit = (o) => process.stdout.write(`${JSON.stringify({ schema: "pilot-eval-v1", ...o })}\n`);
const { src, inputs } = JSON.parse(readFileSync(0, "utf8"));
// One exported function is the only module syntax allowed; strip it and reject any other module syntax.
const body = String(src).replace(/^export\s+(?=function\s+sumRange\b)/gm, "");
if (/\bimport\b|\bexport\b/.test(body)) {
	emit({ rejected: "module syntax other than `export function sumRange` is not evaluated" });
} else {
	const require = createRequire(import.meta.url);
	const { QuickJS } = await import(require.resolve("quickjs-wasi"));
	const wasm = readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"));
	let deadline = 0;
	const vm = await QuickJS.create({ wasm, memoryLimit: 16 * 1024 * 1024, interruptHandler: () => Date.now() > deadline });
	const step = (code) => {
		deadline = Date.now() + 2000;
		return vm.evalCode(code, "candidate.js").consume((h) => vm.dump(h));
	};
	try {
		step(`${body}\n;0`);
		const kind = step("typeof sumRange");
		if (kind !== "function") {
			emit({ rejected: `sumRange is ${kind}, not a function` });
		} else {
			const results = [];
			for (const [a, b] of inputs) {
				try {
					results.push({ ok: true, value: step(`sumRange(${Number(a)}, ${Number(b)})`) });
				} catch (e) {
					results.push({ ok: false, error: String(e?.message ?? e).slice(0, 200) });
				}
			}
			emit({ results });
		}
	} catch (e) {
		emit({ rejected: `candidate evaluation error: ${String(e?.message ?? e).slice(0, 200)}` });
	} finally {
		vm.dispose();
	}
}
