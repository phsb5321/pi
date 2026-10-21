import assert from "node:assert/strict";

// Receipt-oracle validation only. Actual launch/PTY/raw-snapshot production and
// exact artifact verification are separate required gates, never inferred here.
export interface CensusProcess {
	pid: number;
	startTicks: string;
	ppid: number;
	role: "host" | "attachment" | "helper";
	partition: string;
	surface?: string;
	runtime: "javascript" | "native";
	exeSha256: string;
	pssKiB: number;
	swapPssKiB: number;
}

export interface FleetCensus {
	artifactIdentity: string;
	launchedEntrySha256: string;
	rootPid: number;
	completeTree: boolean;
	processes: readonly CensusProcess[];
	surfaces: readonly { id: string; sessionId: string; partition: string; ptyDevice: string }[];
	packetSha256: string;
}

export interface FleetPolicy {
	artifactIdentity: string;
	entrySha256: string;
	partitions: readonly string[];
	surfaces: number;
	qualifiedNativeAttachmentHashes: readonly string[];
	// Must come from the fixed full-tree budget/matched baseline, not a new
	// favorable threshold chosen after the result. Null is an explicit block.
	maxClientTreeKiB: number | null;
}

export function verifyFleetCensus(census: FleetCensus, policy: FleetPolicy): void {
	assert.equal(census.artifactIdentity, policy.artifactIdentity, "Wrong launched artifact");
	assert.equal(census.launchedEntrySha256, policy.entrySha256, "Fixture/manual host is not the actual launch entry");
	assert(census.completeTree && /^[0-9a-f]{64}$/.test(census.packetSha256), "Missing complete raw census packet");
	assert(census.processes.length > 0, "Empty product tree");
	const processes = new Map(census.processes.map((item) => [item.pid, item]));
	assert.equal(processes.size, census.processes.length, "Duplicate PID in snapshot");
	assert(processes.has(census.rootPid), "Product tree root missing");
	const partitions = new Set(policy.partitions);
	const surfaceIds = new Set(census.surfaces.map((row) => row.id));
	assert(Number.isSafeInteger(policy.surfaces) && policy.surfaces > 0, "Invalid actual fleet size");
	assert(partitions.size > 0 && partitions.size === policy.partitions.length, "Invalid partition policy");
	for (const row of census.processes) {
		assert(row.pid > 0 && /^\d+$/.test(row.startTicks), "PID/start identity missing");
		assert(partitions.has(row.partition), "Unexpected host partition");
		if (row.role === "attachment") assert(surfaceIds.has(row.surface ?? ""), "Orphan attachment outside launched surfaces");
		if (row.surface !== undefined) assert(surfaceIds.has(row.surface), "Unknown process surface");
		assert(/^[0-9a-f]{64}$/.test(row.exeSha256), "Executable identity missing");
		assert(Number.isFinite(row.pssKiB) && row.pssKiB >= 0 && Number.isFinite(row.swapPssKiB) && row.swapPssKiB >= 0, "Resident floor missing");
		const seen = new Set<number>();
		let current = row;
		while (current.pid !== census.rootPid) {
			assert(!seen.has(current.pid), "Cycle in census ancestry");
			seen.add(current.pid);
			const parent = processes.get(current.ppid);
			assert(parent, "Census descendant missing parent");
			current = parent;
		}
		if (row.runtime === "javascript") assert.equal(row.role, "host", "Hidden per-attachment/helper JS runtime");
	}
	for (const partition of partitions) {
		const hosts = census.processes.filter((row) => row.role === "host" && row.partition === partition);
		assert.equal(hosts.length, 1, `Partition ${partition}: expected ONE host`);
	}
	assert.equal(census.surfaces.length, policy.surfaces, "Actual fleet launch count differs");
	assert.equal(new Set(census.surfaces.map((row) => row.id)).size, policy.surfaces, "Shared terminal surface identity");
	assert.equal(new Set(census.surfaces.map((row) => row.sessionId)).size, policy.surfaces, "Session alias across surfaces");
	assert.equal(new Set(census.surfaces.map((row) => row.ptyDevice)).size, policy.surfaces, "PTY accidentally shared");
	assert(policy.maxClientTreeKiB !== null && Number.isFinite(policy.maxClientTreeKiB) && policy.maxClientTreeKiB >= 0, "Client floor budget not qualified");
	for (const surface of census.surfaces) {
		assert(partitions.has(surface.partition), "Unknown surface partition");
		const legs = census.processes.filter((row) => row.role === "attachment" && row.surface === surface.id);
		assert.equal(legs.length, 1, "Missing/duplicate native attachment leg");
		assert.equal(legs[0].partition, surface.partition, "Attachment routed to wrong partition");
		assert(policy.qualifiedNativeAttachmentHashes.includes(legs[0].exeSha256), "Unqualified native attachment executable");
		const clientTree = census.processes.filter((row) => {
			let current = row;
			while (current.pid !== census.rootPid) {
				if (current.pid === legs[0].pid) return true;
				const parent = processes.get(current.ppid);
				assert(parent, "Client ancestry missing parent");
				current = parent;
			}
			return false;
		});
		assert(clientTree.every((row) => row.surface === surface.id), "Client descendant surface metadata missing/wrong");
		assert(clientTree.every((row) => row.runtime === "native"), "Client descendant pays hidden JS floor");
		assert(clientTree.every((row) => policy.qualifiedNativeAttachmentHashes.includes(row.exeSha256)), "Unqualified client helper executable");
		const resident = clientTree.reduce((sum, row) => sum + row.pssKiB + row.swapPssKiB, 0);
		assert(resident <= policy.maxClientTreeKiB, `Client resident floor exceeds frozen budget: ${surface.id}`);
	}
}

export const REQUIRED_PARITY = [
	"distinct-terminal-state", "resize-reflow", "kitty-legacy-isolation", "raw-mode",
	"bracketed-paste", "normal-restore", "abrupt-disconnect-restore", "slow-reader-bound",
	"rich-editor-keybindings", "history-scroll-search-tree", "slash-extension-commands",
	"stream-thinking-tools", "images-capable-fallback", "accessibility-navigation", "terminal-actions",
] as const;

export interface ParityEvidence {
	feature: typeof REQUIRED_PARITY[number];
	baselineArtifact: string;
	candidateArtifact: string;
	baselineOracleSha256: string;
	candidateOracleSha256: string;
	baselineSemanticSha256: string;
	candidateSemanticSha256: string;
	executedExit: number | null;
	negativeControlExit: number | null;
	fixtureSha256: string;
}

export function verifyRichParity(rows: readonly ParityEvidence[], baseline: string, candidate: string, presentation: "rich-pi" | "text-20-row"): void {
	assert.equal(presentation, "rich-pi", "Intermediate text projection cannot pass unchanged rich Pi parity");
	assert.equal(rows.length, REQUIRED_PARITY.length, "Missing/extra parity rows");
	for (const feature of REQUIRED_PARITY) {
		const matching = rows.filter((row) => row.feature === feature);
		assert.equal(matching.length, 1, `Missing/duplicate parity oracle: ${feature}`);
		const row = matching[0];
		assert.equal(row.baselineArtifact, baseline, "Wrong native baseline");
		assert.equal(row.candidateArtifact, candidate, "Wrong composed candidate");
		assert.equal(row.executedExit, 0, `Unexecuted/failing parity check: ${feature}`);
		assert(row.negativeControlExit !== null && row.negativeControlExit > 0, `No rejecting control: ${feature}`);
		for (const hash of [row.fixtureSha256, row.baselineOracleSha256, row.candidateOracleSha256, row.baselineSemanticSha256, row.candidateSemanticSha256]) {
			assert(/^[0-9a-f]{64}$/.test(hash), `Unbound parity evidence: ${feature}`);
		}
		assert.equal(row.candidateSemanticSha256, row.baselineSemanticSha256, `Behavioral parity differs: ${feature}`);
	}
}
