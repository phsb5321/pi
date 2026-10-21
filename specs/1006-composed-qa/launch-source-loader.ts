import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { sha256, type SourceEntry, verifySource } from "./identity.ts";

const root = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1006-collapse-compose/composed-source";
const manifest = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1006-collapse-compose/source-manifest.json";
assert.equal(sha256(manifest), "35f5d3fa73efb15969415d09cec97165808e341455eb34f3627c6bf42fee1d25", "Frozen T1 manifest changed");
const path = "packages/coding-agent/src/experimental/durable/shared-thin-main.ts";
const entry = (JSON.parse(readFileSync(manifest, "utf8")) as (SourceEntry & { sha256: string })[]).find((item) => item.path === path);
assert(entry, "Actual frozen entry is missing");
verifySource(root, [entry]);
assert.equal(sha256(`${root}/${path}`), entry.sha256, "Frozen main bytes differ from exact manifest");
const actualUrl = pathToFileURL(`${root}/${path}`).href;
const spiesUrl = new URL("./launch-source-spies.ts", import.meta.url).href;
const dependencies = new Set([
	"@earendil-works/pi-client", "@earendil-works/pi-client/unix", "@earendil-works/pi-tui",
	"../../core/keybindings.ts", "./presentation-host.ts", "./thin-presentation.ts", "./thin-presentation-service.ts",
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "msqa/frozen-launch") return { url: actualUrl, shortCircuit: true };
		if (context.parentURL === actualUrl && dependencies.has(specifier)) return { url: spiesUrl, shortCircuit: true };
		if (context.parentURL === actualUrl) assert(specifier.startsWith("node:"), `Unqualified actual-source dependency: ${specifier}`);
		return nextResolve(specifier, context);
	},
});
