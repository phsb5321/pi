// Xiaomi MiMo exposes the same model through four provider entries (direct
// API billing plus three regional Token Plan endpoints). E2E suites iterate
// this family with one shared describe block; see any *Provider Abort* style
// loop in the test files.
export const XIAOMI_MIMO_FAMILY = [
	["xiaomi", "XIAOMI_API_KEY"],
	["xiaomi-token-plan-cn", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	["xiaomi-token-plan-ams", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	["xiaomi-token-plan-sgp", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
] as const;

import { describe } from "vitest";
import { getModel } from "../src/compat.ts";

type XiaomiMimoModel = ReturnType<typeof getXiaomiMimoModel>;

function getXiaomiMimoModel() {
	return getModel("xiaomi", "mimo-v2.6-pro");
}

/**
 * Runs one e2e describe per Xiaomi MiMo family entry (skipped unless that
 * entry's API key is present), sharing the file-specific test body.
 */
export function describeXiaomiMimoFamily(suite: string, tests: (llm: XiaomiMimoModel) => void): void {
	for (const [provider, envKey] of XIAOMI_MIMO_FAMILY) {
		describe.skipIf(!process.env[envKey])(`Xiaomi MiMo (${suite}, ${provider})`, () => {
			tests(getModel(provider, "mimo-v2.6-pro"));
		});
	}
}
