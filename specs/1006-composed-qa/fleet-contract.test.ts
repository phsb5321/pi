import assert from "node:assert/strict";
import { test } from "node:test";
import { type FleetCensus, type FleetPolicy, type ParityEvidence, REQUIRED_PARITY, verifyFleetCensus, verifyRichParity } from "./fleet-contract.ts";

const hash = "a".repeat(64);
const other = "b".repeat(64);
function fixture(): { census: FleetCensus; policy: FleetPolicy } {
	return {
		policy: { artifactIdentity: "compiled-candidate", entrySha256: hash, partitions: ["one"], surfaces: 2,
			qualifiedNativeAttachmentHashes: [other], maxClientTreeKiB: 128 },
		census: { artifactIdentity: "compiled-candidate", launchedEntrySha256: hash, rootPid: 1,
			completeTree: true, packetSha256: hash,
			processes: [
				{ pid: 1, ppid: 0, startTicks: "100", role: "host", partition: "one", runtime: "javascript", exeSha256: hash, pssKiB: 1000, swapPssKiB: 0 },
				{ pid: 2, ppid: 1, startTicks: "101", role: "attachment", partition: "one", surface: "a", runtime: "native", exeSha256: other, pssKiB: 40, swapPssKiB: 0 },
				{ pid: 3, ppid: 1, startTicks: "102", role: "attachment", partition: "one", surface: "b", runtime: "native", exeSha256: other, pssKiB: 40, swapPssKiB: 0 },
			],
			surfaces: [{ id: "a", sessionId: "sa", partition: "one", ptyDevice: "/dev/pts/owned-a" },
				{ id: "b", sessionId: "sb", partition: "one", ptyDevice: "/dev/pts/owned-b" }],
		},
	};
}

test("oracle only: actual-launch census rejects per-pane hosts and hidden JS/native-floor substitution", () => {
	const { census, policy } = fixture();
	verifyFleetCensus(census, policy);
	assert.throws(() => verifyFleetCensus({ ...census, launchedEntrySha256: other }, policy), /actual launch entry/);
	assert.throws(() => verifyFleetCensus({ ...census, completeTree: false }, policy), /complete raw census/);
	assert.throws(() => verifyFleetCensus({ ...census, processes: [...census.processes, { ...census.processes[0], pid: 4, ppid: 1 }] }, policy), /ONE host/);
	assert.throws(() => verifyFleetCensus({ ...census, processes: census.processes.map((row) => row.pid === 2 ? { ...row, runtime: "javascript" } : row) }, policy), /hidden per-attachment/i);
	assert.throws(() => verifyFleetCensus({ ...census, processes: [...census.processes, { ...census.processes[1], pid: 4, ppid: 2, role: "helper", runtime: "javascript" }] }, policy), /hidden per-attachment/i);
	assert.throws(() => verifyFleetCensus({ ...census, processes: census.processes.map((row) => row.pid === 2 ? { ...row, exeSha256: hash } : row) }, policy), /Unqualified native/);
	assert.throws(() => verifyFleetCensus({ ...census, processes: census.processes.map((row) => row.pid === 2 ? { ...row, pssKiB: 129 } : row) }, policy), /floor exceeds/);
	assert.throws(() => verifyFleetCensus(census, { ...policy, maxClientTreeKiB: null }), /budget not qualified/);
	assert.throws(() => verifyFleetCensus({ ...census, processes: [...census.processes, { ...census.processes[1], pid: 4, ppid: 2, role: "helper", surface: undefined, pssKiB: 100 }] }, policy), /surface metadata/);
	assert.throws(() => verifyFleetCensus({ ...census, surfaces: census.surfaces.map((row) => ({ ...row, ptyDevice: "shared-pty" })) }, policy), /PTY accidentally shared/);
	assert.throws(() => verifyFleetCensus({ ...census, surfaces: census.surfaces.slice(0, 1) }, policy), /outside launched surfaces|launch count differs/);
	assert.throws(() => verifyFleetCensus({ ...census, processes: [...census.processes, { ...census.processes[1], pid: 4, surface: "unreported-leg" }] }, policy), /Orphan attachment/);
	assert.throws(() => verifyFleetCensus(census, { ...policy, surfaces: 0 }), /Invalid actual fleet size/);
});

test("oracle only: every rich/terminal parity row is mandatory; a 20-row text surrogate fails", () => {
	const rows: ParityEvidence[] = REQUIRED_PARITY.map((feature) => ({ feature,
		baselineArtifact: "native-baseline", candidateArtifact: "composed-candidate", baselineOracleSha256: hash,
		candidateOracleSha256: other, baselineSemanticSha256: hash, candidateSemanticSha256: hash,
		executedExit: 0, negativeControlExit: 3, fixtureSha256: other }));
	verifyRichParity(rows, "native-baseline", "composed-candidate", "rich-pi");
	assert.throws(() => verifyRichParity(rows, "native-baseline", "composed-candidate", "text-20-row"), /Intermediate text/);
	for (const feature of REQUIRED_PARITY) {
		assert.throws(() => verifyRichParity(rows.filter((row) => row.feature !== feature), "native-baseline", "composed-candidate", "rich-pi"), /Missing/);
		assert.throws(() => verifyRichParity(rows.map((row) => row.feature === feature ? { ...row, executedExit: null } : row), "native-baseline", "composed-candidate", "rich-pi"), /Unexecuted/);
		assert.throws(() => verifyRichParity(rows.map((row) => row.feature === feature ? { ...row, negativeControlExit: 0 } : row), "native-baseline", "composed-candidate", "rich-pi"), /rejecting control/);
		assert.throws(() => verifyRichParity(rows.map((row) => row.feature === feature ? { ...row, candidateSemanticSha256: other } : row), "native-baseline", "composed-candidate", "rich-pi"), /parity differs/);
	}
});
