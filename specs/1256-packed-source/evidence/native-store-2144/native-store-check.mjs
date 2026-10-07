// Actual SDK/SQLite 2144 check. No mocked openDurable, metadata, adapter or storage.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const selected = join(evidence, 'prepared-source-2144');
const fixture = readFileSync(join(selected, 'test/packed-isolation-306.ts'), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
assert.equal(sha(fixture), 'bf7050ff5dffeef2a3c87fc91aef67dbd445a7bd887b60cbce6155797d27720c');
const slice = (from, to) => {
  const a = fixture.indexOf(from), b = fixture.indexOf(to, a);
  assert(a >= 0 && b > a, `Missing actual source slice ${from}`);
  return fixture.slice(a, b);
};
const pieces = {
  offlineFactory: slice('const faux =', '// Both opens reuse'),
  opener: slice('const sessionDirectories =', '\n// Each session'),
  retainedFactory: slice('const opened =', '\nconst host ='),
  storeConsumer: slice('\tlet storesOpened = 0;', '\n\t// (c)'),
};
const module = p => JSON.stringify(pathToFileURL(join(selected, p)).href);
const header = `import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
const root = join(evidence, 'native-data');
mkdirSync(root, { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.PI_OFFLINE = '1';
const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
const { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
const { AuthStorage } = await import(${module('packages/coding-agent/src/core/auth-storage.ts')});
const { ModelRuntime } = await import(${module('packages/coding-agent/src/core/model-runtime.ts')});
const { openDurable } = await import(${module('packages/coding-agent/src/experimental/durable/runtime.ts')});
const { durableEngineShell } = await import(${module('packages/coding-agent/src/experimental/durable/shared-host-dispatch.ts')});
const { withRetainedHistory } = await import(${module('packages/server/src/retained-history.ts')});
const { openNodeSqliteStorage } = await import(${module('packages/durable/src/storage/sqlite/node.ts')});
const { makeChecks } = await import(${module('packages/coding-agent/src/experimental/durable/shared-host-acceptance-kit.ts')});
const checks = makeChecks();
const runCheck = (label, condition) => { checks.check(label, condition); assert(condition, label); };
const PACKED = 8;
const cohort = Array.from({length:8}, (_, i) => 'native2144-' + i);
for (const id of cohort) mkdirSync(join(root, id), {recursive:true});
`;
const body = `
const context = BACKGROUND_CONTEXT;
const engines = [];
const identities = new Map();
const observations = [];
const marker = 'native-sqlite-durable-marker-2144';
const invoke = (attachment, member, args=[]) => attachment.invokeService({member,args}, async()=>undefined, context);
try {
  for (const id of cohort) {
    const engine = await factory.open({id}, {sessionId:id,generation:1,pid:process.pid}, context);
    engines.push(engine);
    const attachment = await engine.attach(context);
    const current = opened.get(id);
    assert(current, 'actual native SDK opened');
    identities.set(id, {...current.view.current().session});
    assert.equal(sessionDirectories.get(id), current.view.current().session.directory);
    if (id === cohort[0]) {
      await invoke(attachment, 'submit', [marker]);
      const deadline = Date.now()+10000;
      while (!JSON.stringify(current.view.current().conversation.entries).includes('offline fixture answer') || current.view.current().conversation.docs['pi.live']?.run !== undefined) {
        assert(Date.now()<deadline, 'native faux turn settles');
        await new Promise(done=>setTimeout(done,20));
      }
      assert(JSON.stringify(current.view.current().conversation.entries).includes(marker), 'native marker committed');
    }
    await invoke(attachment, 'rh:park');
    assert.equal(opened.has(id), false, 'production release closes/drops actual SDK handle');
    assert.equal(parkState.get(id).released, true);
    const file = join(sessionDirectories.get(id), 'session.sqlite');
    assert.equal(readFileSync(file).subarray(0,16).toString(), 'SQLite format 3\\0');
    assert.equal(readdirSync(join(root,id)).some(p=>p.endsWith('.sqlite')||p.endsWith('.db')),false, 'old cwd scan misses actual native store');
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      assert.equal(Object.values(integrity)[0], 'ok');
      const entryCount = db.prepare('SELECT count(*) AS count FROM entries').get().count;
      const documents = db.prepare('SELECT count(*) AS count FROM documents').get().count;
      if (id === cohort[0]) assert(db.prepare('SELECT record FROM entries').all().some(e=>e.record.includes(marker)));
      observations.push({id, nativeSession:identities.get(id), file, integrity:'ok', entryCount, documents, nativeClosedBeforeSQL:true});
    } finally { db.close(); }
    await attachment.release(context);
  }
  // Exactly the published all8 consumer, using the actual adapter above.
  ${pieces.storeConsumer}
  const resumed = await engines[0].attach(context);
  const entries = await invoke(resumed, 'entries');
  assert(JSON.stringify(entries).includes(marker), 'actual SDK resume reloads persisted user history');
  assert(JSON.stringify(entries).includes('offline fixture answer'), 'actual SDK resume reloads persisted assistant history');
  const view = opened.get(cohort[0]).view.current();
  assert.equal(view.session.id, identities.get(cohort[0]).id);
  assert.equal(view.session.directory, identities.get(cohort[0]).directory);
  assert.equal(sessionDirectories.get(cohort[0]), view.session.directory);
  assert.equal(parkState.get(cohort[0]).resumes,1);
  await resumed.release(context);
  assert.equal(checks.failures,0);
  writeFileSync(join(evidence,'native-store-result.json'), JSON.stringify({result:'PASS_ACTUAL_NATIVE_SDK_SQLITE_PARK_RESUME',sourceCommit:'5e92a08365f3c22c3e78a13f76a8c1fe0227c6b6',selectedEntries:1971,storesOpened,observations,actualSDK:true,actualNodeSqliteAdapter:true,actualSQLiteIntegrity:true,actualRetainedHistoryParkResume:true,actualFauxTurn:1,externalProviderCalls:0,SDKOrStorageMocks:false,full306:false,sharedHostTopologyNotClaimed:true,compilerAndRAMAcceptance:false},null,2)+'\\n');
  console.log('PASS actual SDK directory + actual SQLite all8 + awaited park + same-store native resume/history; not RAM acceptance');
} finally {
  for (const engine of engines) await engine.close(context);
}
`;
const program = stripTypeScriptTypes(header + Object.values(pieces).slice(0,3).join('\n') + body, {mode:'strip'});
writeFileSync(join(evidence,'native-executed-program.mjs'), program);
writeFileSync(join(evidence,'native-source-binding.json'), JSON.stringify({sourceCommit:'5e92a08365f3c22c3e78a13f76a8c1fe0227c6b6',fixtureSHA:sha(fixture),actualSliceSHA:Object.fromEntries(Object.entries(pieces).map(([k,v])=>[k,sha(v)])),executedProgramSHA:sha(program),seams:'Direct actual SDK/source adapter imports. Faux provider is native offline model test dependency; no SDK metadata or SQLite adapter injection.'},null,2)+'\n');
await import(pathToFileURL(join(evidence,'native-executed-program.mjs')).href);
