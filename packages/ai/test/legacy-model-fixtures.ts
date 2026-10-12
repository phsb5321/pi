import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// Keep the Kimi K2.6 transport regressions independent of the Go catalog,
// which no longer lists this model. The Zen catalog still supplies its metadata.
export const legacyOpenCodeGoKimi26: Model<"openai-completions"> = {
	...getModel("opencode", "kimi-k2.6"),
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
};
