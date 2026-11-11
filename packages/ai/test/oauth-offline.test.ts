import { afterEach, expect, it, vi } from "vitest";

const access = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("offline credential access");
	}),
);
vi.mock("fs", () => ({
	chmodSync: access,
	existsSync: access,
	mkdirSync: access,
	readFileSync: access,
	writeFileSync: access,
}));
vi.mock("../src/providers/all.ts", () => ({ builtinProviders: access }));

import { resolveApiKey } from "./oauth.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	access.mockClear();
});

it("offline resolution never reads credentials, refreshes providers, or writes auth storage", async () => {
	vi.stubEnv("PI_OFFLINE", "1");
	for (const provider of ["anthropic", "github-copilot", "openai-codex"]) {
		expect(await resolveApiKey(provider)).toBeUndefined();
	}
	expect(access).not.toHaveBeenCalled();
});
