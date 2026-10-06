/** ROOT1256: one real-source counter/catch/epilogue check; SDK guards are SOURCE only. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = new URL("../specs/1256-packed-source/evidence/", import.meta.url);
const candidatePath = new URL("./packed-isolation-306.ts", import.meta.url);
const baselinePath = new URL("before-packed-isolation-306.ts.txt", evidence);
const kitPath = new URL("../packages/coding-agent/src/experimental/durable/shared-host-acceptance-kit.ts", import.meta.url);
const runtimePath = new URL("../packages/coding-agent/src/core/model-runtime.ts", import.meta.url);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (url: URL) => readFileSync(url, "utf8");
const sdkHead = "f6674860a3b5e812b38211161ce6965546ba2f9a";
const sdkSource = (path: string) => execFileSync("git", ["show", `${sdkHead}:${path}`], {
	cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
});

function sourcePieces(source: string) {
	const counterStart = source.search(/const (?:checks|\{ check, failures: failureCount \}) = makeChecks\(\);/u);
	const counterEnd = source.indexOf("const PACKED =", counterStart);
	const tryStart = source.indexOf("\ntry {\n", counterEnd);
	const catchStart = source.lastIndexOf("} catch (error) {");
	const catchEnd = source.indexOf("\n}", catchStart) + 2;
	assert(counterStart >= 0 && counterEnd > counterStart && tryStart > counterEnd);
	assert(catchStart > tryStart && catchEnd > catchStart);
	const cases = source.slice(tryStart, catchStart).match(/\brunCheck\(/gu)?.length;
	assert.equal(cases, 12, "all twelve original case assertions remain; no weakening");
	return {
		counter: source.slice(counterStart, counterEnd),
		caught: source.slice(catchStart, catchEnd),
		epilogue: source.slice(catchEnd),
		cases,
	};
}

function probe(source: string, mode: "false" | "crash" | "true") {
	const pieces = sourcePieces(source);
	// Inject conditions only. Counter, catch and finalizer are the actual fixture
	// bytes; makeChecks is the production module, not an evaluated counter clone.
	const program = `import { makeChecks } from ${JSON.stringify(pathToFileURL(fileURLToPath(kitPath)).href)};
const PACKED = 306;
${pieces.counter}
try {
 for (let index = 0; index < ${pieces.cases}; index++) {
  runCheck("SOURCE plumbing case " + index, ${JSON.stringify(mode)} !== "false" || index !== 0);
 }
 if (${JSON.stringify(mode)} === "crash") throw new Error("SOURCE injected fixture crash");
${pieces.caught}
${pieces.epilogue}`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval",
		stripTypeScriptTypes(program, { mode: "strip" })], {
		cwd: root, encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024,
		env: { ...process.env, UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--v8-pool-size=1" },
	});
	assert(!child.error && child.signal === null, "child execution/refusal is not source RED/GREEN");
	assert(child.status === 0 || child.status === 3, "import/syntax/other crash is not causal evidence");
	return {
		mode, exit: child.status, stdout: child.stdout, stderr: child.stderr,
		counter_sha256: sha(pieces.counter), catch_sha256: sha(pieces.caught), epilogue_sha256: sha(pieces.epilogue),
	};
}

function guardSourceAbi(source: string) {
	const kit = read(kitPath);
	assert(!/^import .*BACKGROUND_CONTEXT/mu.test(kit), "pure checks must not import Chord at module load");
	assert.match(kit, /async function openAttachedSessions[^]*await import\("@earendil-works\/chord\/context"\)/u);
	const originalKit = read(new URL("before-shared-host-acceptance-kit.ts.txt", evidence));
	const lazyImport = '\tconst { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");\n';
	assert.equal(kit.replace(lazyImport, ""), originalKit.replace('import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";\n', ""), "only the two-line kit import move is authorized");
	for (const pattern of [
		/AuthStorage\.inMemory\(\{\}\)/u, /modelsStore: new InMemoryModelsStore\(\)/u,
		/modelsPath: null/u, /allowModelNetwork: false/u, /refreshOnCreate: false/u,
		/const faux = fauxProvider\(\)/u, /registerNativeProvider\(faux\.provider\)/u,
		/offlineModelRuntime\.refresh\(\{ allowNetwork: false \}\)/u,
		/process\.env\.PI_CODING_AGENT_DIR = join\(root, "agent"\)/u, /process\.env\.PI_OFFLINE = "1"/u,
		/openOffline\(id, false\)/u, /openOffline\(id, true\)/u,
		/openDurable\(\{ cwd: join\(root, id\), continueSession, modelRuntime: offlineModelRuntime \}\)/u,
		/current\.controller\.setModel\(\{ provider: faux\.provider\.id, modelId: faux\.getModel\(\)\.id \}\)/u,
	]) assert.match(source, pattern, `SOURCE ABI guard: ${pattern}`);
	assert.equal(source.match(/\bopenDurable\(/gu)?.length, 1, "initial/resume must use the common runtime-injected open");
	assert.equal(source.match(/\bopenOffline\(/gu)?.length, 2, "both common-open callers are bound");
	assert(source.indexOf("process.env.PI_CODING_AGENT_DIR") < source.indexOf('await import("../packages/coding-agent/src/experimental/durable/runtime.ts")'));
	assert(!source.includes("registerFauxProvider"), "do not borrow compat/global faux registration");
	const modelRuntime = read(runtimePath);
	assert.match(modelRuntime, /modelsStore\?: ModelsStore/u);
	assert.match(modelRuntime, /registerNativeProvider\(provider: Provider\): void/u);
	assert.match(read(new URL("../packages/ai/src/index.ts", import.meta.url)), /export \* from "\.\/providers\/faux\.ts"/u);
	assert.match(read(new URL("../packages/ai/src/providers/faux.ts", import.meta.url)), /export function fauxProvider\(/u);
	const runtime = sdkSource("packages/coding-agent/src/experimental/durable/runtime.ts");
	assert.match(runtime, /readonly modelRuntime\?: ModelRuntime/u);
	assert.match(runtime, /options\.modelRuntime \?\? \(await ModelRuntime\.create\(\)\)/u);
	const resolver = sdkSource("packages/coding-agent/src/experimental/source-resolver.ts");
	assert.match(resolver, /if \(matchedPattern\) \{[^]*throw new Error/u);
	assert.match(sdkSource("tsconfig.json"), /"@earendil-works\/pi-ai": \["\.\/packages\/ai\/src\/index\.ts"\]/u);
	return {
		kind: "SOURCE ABI only; no SDK/provider/factory execution", sdk_git_object: sdkHead,
		sdk_runtime_sha256: sha(runtime), source_resolver_sha256: sha(resolver), model_runtime_sha256: sha(modelRuntime),
	};
}

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (process.argv.includes("--phase")) {
	assert(phase === "baseline" || phase === "candidate");
	const source = read(phase === "baseline" ? baselinePath : candidatePath);
	const outcomes = [probe(source, "false"), probe(source, "crash"), probe(source, "true")];
	const injected = outcomes.slice(0, 2);
	const passed = injected.every((row) => row.exit === 3 && !row.stdout.includes("ALL PASS")) &&
		outcomes[2].exit === 0 && outcomes[2].stdout.includes("ALL PASS");
	const guards = phase === "candidate" ? guardSourceAbi(source) : undefined;
	console.log(JSON.stringify({ phase, source_sha256: sha(source), outcomes, guards, result: passed ? "GREEN" : "RED" }));
	if (!passed) {
		assert(injected.every((row) => row.exit === 0 && row.stdout.includes("ALL PASS") && row.stderr.includes("FAIL")), "baseline must expose the known wrong success, not an unrelated failure");
		console.error("SOURCE RED: baseline real false/caught-crash incorrectly exit0/ALL PASS");
		process.exit(3);
	}
	console.log("SOURCE GREEN: actual helper + fixture counter/catch/epilogue reject false/crash; ABI guards are SOURCE only");
} else {
	const modelBefore = sha(read(runtimePath));
	assert.equal(modelBefore, sha(execFileSync("git", ["show", "HEAD:packages/coding-agent/src/core/model-runtime.ts"], { cwd: root, encoding: "utf8", timeout: 2000 })), "production model API must be unchanged from local base");
	assert.equal(sha(read(baselinePath)), "dc18ab1f83a5558f62dc6a97d61de0425fa952c5872ad70bdfc76a21b8f733dc");
	const runs = ["baseline", "candidate"].map((name) => {
		const args = ["--experimental-strip-types", fileURLToPath(import.meta.url), "--phase", name];
		const child = spawnSync(process.execPath, args, {
			cwd: root, encoding: "utf8", timeout: 12000, maxBuffer: 128 * 1024,
			env: { ...process.env, UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--v8-pool-size=1" },
		});
		writeFileSync(new URL(`${name === "baseline" ? "baseline-red" : "candidate-green"}.log`, evidence), child.stdout + child.stderr);
		assert(!child.error && child.signal === null, "phase dependency/admission failure must stay a failure");
		assert.equal(child.status, name === "baseline" ? 3 : 0, `${name} must be causal RED3/GREEN0`);
		return { phase: name, argv: [process.execPath, ...args], exit: child.status, output_sha256: sha(child.stdout + child.stderr) };
	});
	const modelAfter = sha(read(runtimePath));
	assert.equal(modelBefore, modelAfter);
	const receipt = {
		acceptance: "SOURCE counter/catch/epilogue + source ABI; not native runtime, installed adoption or RAM",
		result: "PASS", node: process.version, source_base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2000 }).trim(),
		check_sha256: sha(read(new URL(import.meta.url))), candidate_sha256: sha(read(candidatePath)), kit_sha256: sha(read(kitPath)),
		model_api_before_sha256: modelBefore, model_api_after_sha256: modelAfter, runs,
		limits: "No SDK construction, providers, packed306, compiler, network or installed state; unresolved native witnesses unchanged",
	};
	writeFileSync(new URL("source-check.json", evidence), JSON.stringify(receipt, null, 2) + "\n");
	console.log(JSON.stringify(receipt, null, 2));
	console.log("packed-source-regression-1256: PASS (baseline RED3, candidate GREEN0; SOURCE only)");
}
