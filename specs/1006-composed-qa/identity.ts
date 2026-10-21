import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SourceEntry {
	path: string;
	mode: string;
	blob: string;
	stage?: number;
}

export function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function containedPath(root: string, path: string): string {
	assert(!isAbsolute(path), `Absolute manifest path: ${path}`);
	const full = resolve(root, path);
	const inside = relative(resolve(root), full);
	assert(inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`), `Escaping manifest path: ${path}`);
	return full;
}

export function verifySource(root: string, entries: readonly SourceEntry[]): number {
	assert(entries.length > 0, "Empty source manifest");
	const seen = new Set<string>();
	for (const entry of entries) {
		assert(entry.stage === undefined || entry.stage === 0, `Unmerged entry: ${entry.path}`);
		assert(!seen.has(entry.path), `Duplicate source path: ${entry.path}`);
		seen.add(entry.path);
		const full = containedPath(root, entry.path);
		const stat = lstatSync(full);
		let data: Buffer;
		if (entry.mode === "120000") {
			assert(stat.isSymbolicLink(), `Expected source symlink: ${entry.path}`);
			data = Buffer.from(readlinkSync(full));
		} else {
			assert(stat.isFile() && !stat.isSymbolicLink(), `Expected physical source file: ${entry.path}`);
			assert.equal(entry.mode, stat.mode & 0o111 ? "100755" : "100644", `Mode mismatch: ${entry.path}`);
			data = readFileSync(full);
		}
		const blob = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
		assert.equal(blob, entry.blob, `Blob mismatch: ${entry.path}`);
	}
	return seen.size;
}

export interface InputManifest {
	count: number;
	symlinks: readonly { path: string; target: string }[];
	overlay_data_files: Readonly<Record<string, string>>;
	selected_manifest_sha256: string;
}

export interface ComposedInputManifest {
	aliases_and_dependencies: readonly { path: string; target: string }[];
	catalogue_files_sha256: Readonly<Record<string, string>>;
	source_manifest_sha256: string;
}

export function normalizeInputs(input: InputManifest | ComposedInputManifest): InputManifest {
	if (!("aliases_and_dependencies" in input)) return input;
	return { count: input.aliases_and_dependencies.length, symlinks: input.aliases_and_dependencies,
		overlay_data_files: input.catalogue_files_sha256, selected_manifest_sha256: input.source_manifest_sha256 };
}

export function verifyInputs(root: string, input: InputManifest, sourceSha: string): { links: number; catalogue: number } {
	assert.equal(input.selected_manifest_sha256, sourceSha, "Inputs bind wrong source tuple");
	assert.equal(input.symlinks.length, input.count, "Input count mismatch");
	const seen = new Set<string>();
	for (const link of input.symlinks) {
		const full = containedPath(root, link.path);
		assert(!seen.has(full), `Duplicate input path: ${link.path}`);
		seen.add(full);
		assert(lstatSync(full).isSymbolicLink(), `Missing input symlink: ${link.path}`);
		assert.equal(readlinkSync(full), link.target, `Input target changed: ${link.path}`);
		assert(existsSync(full), `Broken input link: ${link.path}`);
	}
	const catalogueRoot = resolve(root, "packages/ai/src/providers/data");
	for (const [file, hash] of Object.entries(input.overlay_data_files)) {
		assert.equal(sha256(containedPath(catalogueRoot, file)), hash, `Catalogue changed: ${file}`);
	}
	return { links: seen.size, catalogue: Object.keys(input.overlay_data_files).length };
}

export interface ArtifactReceipt {
	schema: "memory-sound-qa-artifact/1";
	root: string;
	sourceRoot: string;
	sourceManifest: { path: string; sha256: string };
	inputManifest: { path: string; sha256: string };
	build: { exit: number; complete: boolean; log: string; logSha256: string };
	modules: Record<string, string>;
	// Absolute paths and hashes of ALL compiled modules and runtime dependencies.
	runtimeFiles: Record<string, string>;
}

export function verifyArtifact(receipt: ArtifactReceipt): void {
	assert.equal(receipt.schema, "memory-sound-qa-artifact/1");
	assert.equal(receipt.build.exit, 0, "Build failed");
	assert.equal(receipt.build.complete, true, "Build incomplete");
	for (const item of [receipt.sourceManifest, receipt.inputManifest]) {
		assert.equal(sha256(item.path), item.sha256, `Manifest changed: ${item.path}`);
	}
	const sourceEntries = JSON.parse(readFileSync(receipt.sourceManifest.path, "utf8")) as SourceEntry[];
	verifySource(receipt.sourceRoot, sourceEntries);
	const inputs = normalizeInputs(JSON.parse(readFileSync(receipt.inputManifest.path, "utf8")) as InputManifest | ComposedInputManifest);
	verifyInputs(receipt.sourceRoot, inputs, receipt.sourceManifest.sha256);
	assert.equal(sha256(receipt.build.log), receipt.build.logSha256, "Build log changed");
	assert(Object.keys(receipt.modules).length > 0, "No composed modules");
	for (const [name, path] of Object.entries(receipt.modules)) {
		const full = containedPath(receipt.root, path);
		const actual = realpathSync(full);
		assert.equal(actual, full, `Module symlink substitution: ${name}`);
		assert(/\.(mjs|cjs|js)$/.test(path) && !path.includes("/src/"), `Not compiled output: ${name}`);
		assert(receipt.runtimeFiles[actual], `Unbound compiled module: ${name}`);
	}
	for (const [path, hash] of Object.entries(receipt.runtimeFiles)) {
		assert(isAbsolute(path), `Nonabsolute runtime path: ${path}`);
		assert.equal(sha256(path), hash, `Runtime identity mismatch: ${path}`);
	}
}

export const ACED_LIMITS: Readonly<Record<string, { direction: "max" | "min"; value: number }>> = {
	sqale_rating: { direction: "max", value: 1 },
	reliability_rating: { direction: "max", value: 1 },
	security_rating: { direction: "max", value: 1 },
	new_maintainability_rating: { direction: "max", value: 1 },
	new_reliability_rating: { direction: "max", value: 1 },
	new_security_rating: { direction: "max", value: 1 },
	new_coverage: { direction: "min", value: 80 },
	new_violations: { direction: "max", value: 0 },
	new_security_hotspots_reviewed: { direction: "min", value: 100 },
	new_duplicated_lines_density: { direction: "max", value: 3 },
};

export function verifyAced(measures: Readonly<Record<string, number | null>>): void {
	for (const [metric, limit] of Object.entries(ACED_LIMITS)) {
		const actual = measures[metric];
		assert(typeof actual === "number" && Number.isFinite(actual) && actual >= 0, `Missing/invalid metric: ${metric}`);
		assert(limit.direction === "max" ? actual <= limit.value : actual >= limit.value, `ACED failed: ${metric}=${actual}`);
	}
}
