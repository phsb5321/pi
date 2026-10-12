import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allowNetwork } from "./test-network-env.ts";

// Fresh-install contract: the FIRST reference to an extension source must
// install AND load its extensions in the same process. A reference that only
// installs (loading happens "next run") forces callers into duplicated
// --extension flags; that is the regression this file pins.

interface StubbedPackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
	parseSource(
		source: string,
	):
		| { type: "npm"; spec: string; name: string; pinned: boolean }
		| { type: "git"; repo: string; host: string; path: string; pinned: boolean; ref?: string }
		| { type: "local"; path: string };
	getNpmInstallPath(
		source: { type: "npm"; spec: string; name: string; pinned: boolean },
		scope: "user" | "project" | "temporary",
	): string;
}

const TINY_EXTENSION = `
	import { Type } from "typebox";
	export default function(pi) {
		pi.registerTool({
			name: "tiny-tool",
			label: "tiny-tool",
			description: "Fresh-install fixture tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
	}
`;

function materializeTinyPackage(root: string): void {
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "tiny.ts"), TINY_EXTENSION);
}

describe("first reference to an extension source installs AND loads it", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-ext-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	function createLoader(source: string, options?: { allowInstall?: boolean }): DefaultResourceLoader {
		if (options?.allowInstall !== false) allowNetwork();
		// Fresh agentDir + empty settings: the source is referenced exactly once,
		// through the same surface as `--extension <source>`.
		const settingsManager = SettingsManager.create(cwd, agentDir);
		return new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [source],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}

	function expectTinyToolLoaded(loader: DefaultResourceLoader): void {
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("tiny-tool")).toBe(true);
	}

	it("loads a file: source on the first reference", async () => {
		const sourceDir = join(tempDir, "src-pkg");
		materializeTinyPackage(sourceDir);
		const loader = createLoader(join(sourceDir, "extensions", "tiny.ts"));
		await loader.reload();
		expectTinyToolLoaded(loader);
	});

	it("installs and loads a fresh git: source on the first reference", async () => {
		const loader = createLoader("git:github.com/acme/tiny-ext");
		const packageManager = (loader as unknown as { packageManager: StubbedPackageManagerInternals }).packageManager;
		packageManager.runCommand = async (command, args) => {
			if (command === "git" && args[0] === "clone") {
				const targetDir = args[2] as string;
				materializeTinyPackage(targetDir);
				return;
			}
			throw new Error(`Unexpected command in fixture: ${command} ${args.join(" ")}`);
		};
		await loader.reload();
		expectTinyToolLoaded(loader);
	});

	it("installs and loads a fresh npm: source on the first reference", async () => {
		const loader = createLoader("npm:tiny-ext");
		const packageManager = (loader as unknown as { packageManager: StubbedPackageManagerInternals }).packageManager;
		packageManager.runNpmCommand = async () => {
			const parsed = packageManager.parseSource("npm:tiny-ext");
			if (parsed.type !== "npm") throw new Error("fixture expects an npm source");
			const installedPath = packageManager.getNpmInstallPath(parsed, "temporary");
			materializeTinyPackage(installedPath);
			writeFileSync(
				join(installedPath, "package.json"),
				`${JSON.stringify({ name: "tiny-ext", version: "1.0.0" })}\n`,
			);
		};
		await loader.reload();
		expectTinyToolLoaded(loader);
	});

	it("surfaces an error when an explicit source cannot be installed", async () => {
		// PI_OFFLINE stays on: the install is refused. The reference must not
		// vanish silently — the loader already moved past it is the regression.
		const loader = createLoader("git:github.com/acme/tiny-ext", { allowInstall: false });
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.some((e) => e.error.includes("git:github.com/acme/tiny-ext"))).toBe(true);
	});

	it("surfaces an error when an installed source contains no resources", async () => {
		const loader = createLoader("git:github.com/acme/empty-ext");
		const packageManager = (loader as unknown as { packageManager: StubbedPackageManagerInternals }).packageManager;
		packageManager.runCommand = async (command, args) => {
			if (command === "git" && args[0] === "clone") {
				mkdirSync(args[2] as string, { recursive: true });
				return;
			}
			throw new Error(`Unexpected command in fixture: ${command} ${args.join(" ")}`);
		};
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.some((e) => e.error.includes("git:github.com/acme/empty-ext"))).toBe(true);
	});

	it("control: the same source stays loaded across a second reload", async () => {
		const sourceDir = join(tempDir, "src-pkg-2");
		materializeTinyPackage(sourceDir);
		const loader = createLoader(join(sourceDir, "extensions", "tiny.ts"));
		await loader.reload();
		await loader.reload();
		expectTinyToolLoaded(loader);
	});
});
