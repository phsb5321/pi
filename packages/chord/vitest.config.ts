// Chord's Node tests use workspace sources and canonical temporary paths.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// Spawned processes and bundles still need built workspace packages.
export default defineConfig({
	test: {
		environment: "node",
		// One bound for the package, as in packages/durable (run-budget.ts): the 5 s default failed a different
		// pair of tests in each of runs 503, 510 and 515 on the Forgejo runner (store, app, sync, files, process),
		// while each needs 0.06 to 2.5 s alone (sync.test.ts "ends a batch at BATCH_BYTES" 2.5 s, files.test.ts
		// "spaces" 0.06 s on a 4-core desktop). 30 s is 12x the slowest of them; a hang still fails in half a minute.
		testTimeout: 30_000,
		// Fixtures and esbuild must name the same files when macOS's temporary directory is a symlink.
		env: { TMPDIR: realpathSync(tmpdir()) },
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
