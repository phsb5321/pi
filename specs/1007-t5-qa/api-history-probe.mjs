// Public ABI only: the seed/A/B adapter exercises these same physical exports.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStorage, ModelRuntime, createSharedTtyHost, main, openDurable, runDurableTui } from 'memory-proof/shared-tty';

const exports = { AuthStorage, ModelRuntime, createSharedTtyHost, main, openDurable, runDurableTui };
for (const [name, value] of Object.entries(exports)) assert.equal(typeof value, 'function', `Missing public ${name}`);
writeFileSync(join(process.env.MP_ROOT, 'six-export-api.json'), JSON.stringify({ exports: Object.keys(exports),
  mainScope: 'public emitted export; default CLI execution is a separate producer prerequisite',
  executionMode: 'compiled-native', fixture: false }));
