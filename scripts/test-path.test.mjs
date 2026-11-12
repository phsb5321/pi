import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("test launcher removes inaccessible inherited PATH directories", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-test-path-"));
	const denied = path.join(root, "denied");
	const bin = path.join(root, "bin");
	try {
		mkdirSync(denied, { mode: 0 });
		mkdirSync(bin);
		writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "SEARCH_PATH=%s\\n" "$PATH"\n', { mode: 0o755 });
		const result = spawnSync("bash", ["test.sh"], {
			cwd: new URL("../", import.meta.url),
			env: { ...process.env, PATH: `${denied}:${bin}:${process.env.PATH}` },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const inherited = result.stdout.split("SEARCH_PATH=")[1]?.trim().split(path.delimiter);
		assert.ok(inherited?.includes(bin));
		assert.ok(!inherited?.includes(denied));
	} finally {
		chmodSync(denied, 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});
