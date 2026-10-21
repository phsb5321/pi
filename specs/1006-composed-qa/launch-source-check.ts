import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { main } from "msqa/frozen-launch";
import { trace } from "./launch-source-spies.ts";

const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
await Promise.all([
	main(["/synthetic/partition", "/synthetic/pane-a.sock", "pane-a", "306"]),
	main(["/synthetic/partition", "/synthetic/pane-b.sock", "pane-b", "306"]),
]);
assert.deepEqual(trace.hosts.map((host) => host.sessions).sort(), [["pane-a"], ["pane-b"]]);
assert(trace.hosts.every((host) => host.closed), "Spy lifecycle must settle");
assert.equal(trace.uiStarts, 2);
assert.equal(trace.uiStops, 2);
assert.equal(process.listenerCount("SIGINT"), before.SIGINT, "Actual main cleans SIGINT handler");
assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM, "Actual main cleans SIGTERM handler");
const failures = [];
if (trace.hosts.length !== 1) failures.push(`one configured partition launched ${trace.hosts.length} hosts, expected 1`);
if (trace.processTerminals !== 0) failures.push(`pane-side entry constructs ${trace.processTerminals} ProcessTerminal/JS UI runtimes, expected attachment-only non-Node legs`);
const evidence = {
	result: failures.length ? "RED_ACTUAL_FROZEN_MAIN_CONTROL_FLOW" : "NARROW_SOURCE_POLICY_PASS_NOT_PRODUCT_ACCEPTANCE",
	scope: "Exact actual main invoked twice with dependency constructor spies; no real host/process census/PTY/provider/build. This is NOT full-fleet or runtime-floor measurement.",
	sourceTuple: "T1-1006-native-lazy-compose-35f5d3fa73ef",
	entrySha256: "663ea5a4c88361520456814369538942309cc9749f0d9a673ec5a9dbf72a6bfe",
	trace, failures, requiredFutureOracle: "Launch the corrected actual artifact fleet entry and census all descendants at matched N; classify host and each attachment executable and measure total tree PSS+SwapPss.",
};
writeFileSync(new URL("./launch-source-result.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
process.stdout.write(`${evidence.result}\n`);
process.exitCode = failures.length ? 3 : 0;
