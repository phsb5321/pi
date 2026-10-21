import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ArtifactReceipt, containedPath, sha256, verifyArtifact } from "./identity.ts";

const receiptPath = process.env.MSQA_ARTIFACT_RECEIPT;
assert(receiptPath, "BLOCKED: MSQA_ARTIFACT_RECEIPT must bind an independently verified green composed build");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as ArtifactReceipt;
verifyArtifact(receipt);
const ownRoot = fileURLToPath(new URL("./", import.meta.url));
const dataRoot = process.env.MSQA_DATA_ROOT;
assert(dataRoot && resolve(dataRoot) === dataRoot, "An absolute, owned durable MSQA_DATA_ROOT is required");
assert(dataRoot.startsWith(`${join(ownRoot, "native-data")}${sep}`), "Native data must stay in the owned QA native-data directory");
assert(!existsSync(dataRoot) || readdirSync(dataRoot).length === 0, "Native data root must be fresh; existing evidence is never cleaned");
mkdirSync(dataRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dataRoot, "agent");
process.env.PI_OFFLINE = "1";
// Admission must additionally isolate egress; these guards refuse accidental
// provider/model-refresh calls before any compiled product module is evaluated.
globalThis.fetch = async () => { throw new Error("MSQA: HTTP/network calls forbidden"); };
Socket.prototype.connect = function () { throw new Error("MSQA: socket/network calls forbidden"); };
const seen = new Set<string>();
registerHooks({
	resolve(specifier, context, nextResolve) {
		const mapped = receipt.modules[specifier];
		const result = mapped
			? { url: pathToFileURL(containedPath(receipt.root, mapped)).href, shortCircuit: true }
			: nextResolve(specifier, context);
		if (result.url.startsWith("file:")) {
			const path = realpathSync(fileURLToPath(result.url));
			if (!path.startsWith(ownRoot)) {
				assert(!/\.(ts|mts|cts)$/.test(path), `Source fallback refused: ${path}`);
				const expected = receipt.runtimeFiles[path];
				assert(expected, `Unqualified loaded module: ${path}`);
				assert.equal(sha256(path), expected, `Loaded module changed: ${path}`);
				if (!seen.has(path)) {
					seen.add(path);
					process.stdout.write(`MSQA_LOADED ${path} ${expected}\n`);
				}
			}
		}
		return result;
	},
});
