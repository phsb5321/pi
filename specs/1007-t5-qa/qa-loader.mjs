import assert from "node:assert/strict";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { Socket } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeInputs, sha256, verifyInputs, verifySource } from "../1006-composed-qa/identity.ts";

const source = process.env.MSQA_SOURCE;
const data = process.env.MSQA_DATA;
const socketRoot = process.env.MSQA_SOCKET_ROOT;
assert(source && data && socketRoot, "Owned source/data/socket paths required");
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { throw new Error("MSQA: network/provider HTTP forbidden"); };
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	let options = args[0];
	if (Array.isArray(options)) options = options[0];
	const path = typeof options === "string" ? options : options?.path;
	assert(typeof path === "string", "MSQA: TCP sockets forbidden");
	const inside = relative(socketRoot, resolve(path));
	assert(inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep), "MSQA: only owned Unix sockets allowed");
	return connect.apply(this, args);
};
const artifactPath = process.env.MSQA_ARTIFACT_RECEIPT;
const artifact = artifactPath ? JSON.parse(readFileSync(artifactPath, "utf8")) : undefined;
const sourceFiles = new Set();
if (artifact) {
	assert.equal(sha256(artifactPath), process.env.MSQA_RECEIPT_SHA256, "Qualified receipt drift");
	assert.equal(source, artifact.sourceRoot);
	for (const item of [artifact.sourceManifest, artifact.inputManifest]) assert.equal(sha256(item.path), item.sha256);
	const rows = JSON.parse(readFileSync(artifact.sourceManifest.path, "utf8"));
	verifySource(source, rows);
	for (const row of rows) sourceFiles.add(resolve(source, row.path));
	verifyInputs(source, normalizeInputs(JSON.parse(readFileSync(artifact.inputManifest.path, "utf8"))), artifact.sourceManifest.sha256);
	for (const stage of [artifact.check, artifact.build]) {
		assert.equal(stage.exit, 0); assert.equal(stage.complete, true); assert.equal(sha256(stage.log), stage.logSha256);
	}
	for (const [file, hash] of Object.entries(artifact.runtimeFiles)) assert.equal(sha256(file), hash, `Runtime drift: ${file}`);
}
const aliases = artifact ? artifact.modules : {
	"proper-lockfile": createRequire(join(source, "package.json")).resolve("proper-lockfile"),
	"msqa/ai": "packages/ai/src/index.ts",
	"msqa/tui": "packages/tui/src/index.ts",
	"msqa/auth": "packages/coding-agent/src/core/auth-storage.ts",
	"msqa/models": "packages/coding-agent/src/core/model-runtime.ts",
	"msqa/host": "packages/coding-agent/src/experimental/durable/shared-tty-host.ts",
	"msqa/theme": "packages/coding-agent/src/modes/interactive/theme/theme.ts",
};
const qaMain = fileURLToPath(new URL("./rich-host.mjs", import.meta.url));
function qualified(url) {
	if (!artifact || !url.startsWith("file:")) return;
	const file = realpathSync(fileURLToPath(url));
	if (file === qaMain) return;
	assert(!/\.(ts|mts|cts)$/.test(file) && !sourceFiles.has(file) && !file.includes("source-resolver"), `Product source/resolver fallback: ${file}`);
	assert(artifact.runtimeFiles[file], `Omitted loaded runtime dependency: ${file}`);
	assert.equal(sha256(file), artifact.runtimeFiles[file], `Loaded runtime drift: ${file}`);
	return file;
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		const path = aliases[specifier] ?? artifact?.dependencyModules?.[specifier];
		const result = path ? { url: pathToFileURL(path.startsWith("/") ? path : join(artifact?.root ?? source, path)).href, shortCircuit: true }
			: nextResolve(specifier, context);
		qualified(result.url);
		return result;
	},
	load(url, context, nextLoad) {
		const file = qualified(url);
		const result = nextLoad(url, context);
		if (file) {
			assert(!String(result.format).includes("typescript"), "Loaded TypeScript product forbidden");
			appendFileSync(join(data, "loaded-runtime.jsonl"), `${JSON.stringify({ path: file, sha256: sha256(file), format: result.format })}\n`);
		}
		return result;
	},
});
