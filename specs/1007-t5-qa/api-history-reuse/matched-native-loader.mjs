// Exact compiled native ABI resolution. Authorized product mode forbids source fallback.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const contract = JSON.parse(readFileSync(process.env.MP_CONTRACT, 'utf8'));
if (contract.artifact.execution_mode !== 'compiled-native') throw new Error('Compiled native execution required');
const sourceExtensions = new Set(['.ts', '.mts', '.cts']);
const checked = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = contract.artifact.modules[specifier];
    if (specifier.startsWith('memory-proof/') || specifier.startsWith('@earendil-works/')) {
      if (!entry) throw new Error(`No exact native ABI binding: ${specifier}`);
      if (sourceExtensions.has(extname(entry.path))) throw new Error(`Source fallback forbidden: ${entry.path}`);
      if (!contract.artifact.files[entry.path]) throw new Error(`Unbound native ABI entry: ${entry.path}`);
      return { url: pathToFileURL(entry.path).href, shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('file:') && sourceExtensions.has(extname(fileURLToPath(result.url)))) {
      throw new Error(`Source fallback forbidden: ${result.url}`);
    }
    return result;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const path = fileURLToPath(url);
      if (sourceExtensions.has(extname(path))) throw new Error(`Source fallback forbidden: ${path}`);
      const expected = contract.artifact.files[path] ?? contract.instrument_files[path];
      if (!expected) throw new Error(`Unbound loaded code: ${path}`);
      if (!checked.has(path)) {
        const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
        if (actual !== expected) throw new Error(`Loaded artifact hash mismatch: ${path}`);
        checked.add(path);
        appendFileSync(process.env.MP_LOAD_LOG, `${JSON.stringify({ pid: process.pid, path, sha256: actual })}\n`);
      }
    }
    return nextLoad(url, context);
  },
});
