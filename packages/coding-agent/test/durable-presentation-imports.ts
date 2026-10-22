import assert from "node:assert/strict";
import { build } from "esbuild";

// The TUI previously imported agentOf through runtime.ts and loaded the entire SDK.
const result = await build({
	entryPoints: ["packages/coding-agent/src/experimental/durable/presentation-client.ts"],
	bundle: true,
	packages: "external",
	platform: "node",
	write: false,
	metafile: true,
	logLevel: "silent",
});
const files = Object.keys(result.metafile!.inputs);
for (const forbidden of [
	"experimental/durable/runtime.ts",
	"core/model-runtime.ts",
	"experimental/durable/harness-setup.ts",
	"experimental/durable/shared-host-residency.ts",
]) {
	assert.ok(!files.some((file) => file.endsWith(forbidden)), `Thin presentation reaches SDK source: ${forbidden}`);
}
assert.ok(files.some((file) => file.endsWith("experimental/durable/tui.ts")));
console.log(
	`PRESENTATION-IMPORTS: ${files.length} local presentation modules; no SDK creation/model runtime/storage entry. External packages are not counted; this is not a RAM measurement.`,
);
