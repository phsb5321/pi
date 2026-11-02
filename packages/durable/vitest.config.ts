import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { runBudget } from "./test/run-budget.ts";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		// One bound for the package, not a number per test: the 5 s default failed under runner
		// load in six different suites while every failing test needed < 1.4 s standalone, so any
		// per-test list is whack-a-mole. runBudget(30) is 60 s here — 1.7x the worst durable test
		// CI has actually measured (~35 s) — and it keeps every test at or above the headroom it had.
		testTimeout: runBudget(30),
		// Run in workerd by their own config: `npm run test:workers`.
		exclude: [...configDefaults.exclude, "test-workers/**"],
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
