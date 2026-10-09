// Owned bounded Azure qualification v2 (PORT09 precision): API-grouped via
// groupProviderModelData + source constants (thinking map, context overrides,
// deepseek compat); manifest+validate = SCHEMA verdict only.
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, rmSync } from "node:fs";
import { groupProviderModelData, createModelDataManifest, validateGeneratedModelData, readModelDataStructure } from "/home/notroot/Documents/Code/pi-upstream-2308-src-freeze/export-target/packages/ai/scripts/model-data.ts";
const S2310 = "/home/notroot/Documents/Code/pi-upstream-2310-settings-retry-leaf";
const WT = "/home/notroot/Documents/Code/pi-upstream-2308-src-freeze";
const AI = `${WT}/export-target/packages/ai`;
const DATA_SRC = `${S2310}/packages/ai/src/providers/data`;
const OWNED = `${WT}/input-overlay/ai-data`;
mkdirSync(OWNED, { recursive: true });
for (const f of readdirSync(DATA_SRC)) cpSync(`${DATA_SRC}/${f}`, `${OWNED}/${f}`);
// The current frozen source deleted the old azure-openai-responses shard:
// the stale cache file must not be present in the qualified data.
rmSync(`${OWNED}/azure-openai-responses.json`, { force: true });
const rows = (obj: Record<string, unknown>): Array<Record<string, unknown>> =>
	Object.values(obj).flatMap((prov) => (prov && typeof prov === "object" && !Array.isArray(prov) ? Object.values(prov as Record<string, unknown>) : []))
		.filter((v) => v && typeof v === "object" && "id" in (v as Record<string, unknown>)) as Array<Record<string, unknown>>;
const openai = JSON.parse(readFileSync(`${DATA_SRC}/openai.json`, "utf8"));
const deepseek = JSON.parse(readFileSync(`${DATA_SRC}/deepseek.json`, "utf8"));
const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
	"gpt-5.4": 1050000, "gpt-5.5": 1050000, "gpt-5.6-luna": 1050000, "gpt-5.6-sol": 1050000, "gpt-5.6-terra": 1050000,
};
const AZURE_DEEPSEEK_V4_PRO_COST = { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 };
const AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;
const all = [...rows(openai), ...rows(deepseek)];
const azure = [
	...all.filter((m) => m.provider === "openai" && m.api === "openai-responses").map((m) => ({
		...m, api: "azure-openai-responses", provider: "azure", baseUrl: "",
		cost: { input: (m.cost as Record<string, unknown>).input, output: (m.cost as Record<string, unknown>).output, cacheRead: (m.cost as Record<string, unknown>).cacheRead, cacheWrite: (m.cost as Record<string, unknown>).cacheWrite },
		contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[m.id as string] ?? m.contextWindow,
	})),
	...all.filter((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro").map((m) => ({
		...m, provider: "azure", baseUrl: "", cost: AZURE_DEEPSEEK_V4_PRO_COST,
		compat: { ...(m.compat as Record<string, unknown>), supportsDeveloperRole: false, supportsMidConvoSystemMessages: true, thinkingFormat: "openai", supportsLongCacheRetention: false },
		thinkingLevelMap: AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP,
	})),
];
const { groups } = groupProviderModelData("azure", azure);
writeFileSync(`${OWNED}/azure.json`, JSON.stringify(groups, null, "\t") + "\n");
const structure = readModelDataStructure(AI);
const fileContents: Record<string, string> = {};
for (const f of readdirSync(OWNED)) { if (f !== ".manifest.json") fileContents[f] = readFileSync(`${OWNED}/${f}`, "utf8"); }
const manifest = createModelDataManifest(structure, fileContents, "2026-10-06T08:00:00.000Z");
writeFileSync(`${OWNED}/.manifest.json`, JSON.stringify(manifest, null, "\t") + "\n");
try {
	validateGeneratedModelData(AI);
	console.log("SCHEMA-VERDICT: PASS (manifest + self-derived ID/API consistency)");
} catch (e) {
	console.log("SCHEMA-VERDICT: FAIL:", e instanceof Error ? e.message : String(e));
	process.exitCode = 1;
}
console.log("CONTENT-COMPAT: NOT-PROVEN (12 generator metadata passes not fully extracted pure; thinking-map + context-overrides + deepseek-compat applied as source constants)");
