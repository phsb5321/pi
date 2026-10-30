import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Daemon-heavy files (remote, conformance, differential, terminal) each spawn real
		// pi-env processes; run concurrently they race and the daemon panics (exit 101) —
		// reproduced on pristine upstream v1.4.0, 29/10/2026. One file at a time is the fix.
		fileParallelism: false,
	},
	resolve: {
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
