// Preserved standalone native-rich A and one shared B use the SAME compiled entry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { AuthStorage, ModelRuntime, openDurable, runDurableTui, createSharedTtyHost } from 'memory-proof/shared-tty';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Append through public native Storage, without rebuilding a private registry/Harness. */
export async function seedNativeHistory(database, history) {
  assert(history.length > 0 && history.length <= 850, 'Unsupported native seed size');
  for (const message of history) {
    assert(['user', 'assistant'].includes(message.role), 'Unsupported native seed role');
    assert(typeof message.content === 'string' && Number.isSafeInteger(message.timestamp), 'Invalid native seed message');
  }
  const storage = await openNodeSqliteStorage(database);
  try {
    assert(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT), 'Native root missing');
    const entries = [];
    for (const message of history) {
      entries.push({ id: await storage.mintId(), conversationId: ROOT_CONVERSATION_ID,
        kind: message.role === 'user' ? 'pi.user' : 'pi.assistant',
        model: [message.role === 'user' ? message : fauxAssistantMessage(message.content, { timestamp: message.timestamp })] });
    }
    const initial = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1, undefined, BACKGROUND_CONTEXT);
    assert.equal(initial.items.length, 0, 'Native seed is not empty');
    await storage.commit(entries.map(value => ({ type: 'entry', value })), BACKGROUND_CONTEXT);
    const readback = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, BACKGROUND_CONTEXT);
      readback.push(...page.items);
      assert(readback.length <= entries.length, 'Extra native history');
      cursor = page.next;
      if (cursor !== undefined) {
        assert(!cursors.has(cursor), 'Repeated native history cursor');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    assert.deepEqual(readback.reverse(), entries, 'Native seed readback mismatch');
    return { entries: readback.length, messages_sha256: digest(readback.flatMap(entry => entry.model)), readback };
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

async function main() {
  const job = JSON.parse(readFileSync(process.env.MP_CONTRACT, 'utf8'));
  const root = process.env.MP_ROOT;
  const events = process.env.MP_EVENTS;
  const [mode, selected] = process.argv.slice(2);
  const ids = Array.from({ length: job.N }, (_, i) => `seat-${i}`);
  const emit = (id, event, data = {}) => appendFileSync(events, `${JSON.stringify({ id, event, arm: mode, pid: process.pid, at: Date.now(), ...data })}\n`);
  assert(['seed', 'A', 'B'].includes(mode));
  process.env.PI_OFFLINE = '1';

  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider();
  const ref = { provider: faux.provider.id, modelId: faux.getModel().id };
  if (mode !== 'seed') {
    const response = request => {
      const user = request.messages.findLast(message => message.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const match = /^MP:(seat-[0-9]+):(warm|measure)$/.exec(text);
      assert(match && ids.includes(match[1]), 'Wrong workload/session');
      const [, id, phase] = match;
      const normalized = request.messages.map(message => ({ role: message.role, content: message.content }));
      if (phase === 'warm') {
        const seed = request.messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(0, job.history.length);
        const expected = job.history.map(message => ({ role: message.role, content: message.role === 'assistant' ? fauxAssistantMessage(message.content).content : message.content }));
        assert.deepEqual(seed.map(message => ({ role: message.role, content: message.content })), expected, 'Native history mismatch');
      }
      emit(id, 'request', { phase, messages: request.messages.length, history_sha256: digest(normalized) });
      if (phase === 'warm') return fauxAssistantMessage(`MP-WARM-${id}`, { timestamp: 1 });
      const tool = request.messages.findLast(message => message.role === 'toolResult');
      if (tool?.toolCallId === `MP-${id}`) {
        assert(!tool.isError && JSON.stringify(tool.content).includes('MP-TOOL-DONE'));
        emit(id, 'tool-result', { phase });
        return fauxAssistantMessage(`MP-ANSWER-${id}`, { timestamp: 1 });
      }
      emit(id, 'tool-submitted', { phase });
      return fauxAssistantMessage([fauxToolCall('bash', { command: job.workload.tool_command, timeout: job.workload.tool_timeout_s }, { id: `MP-${id}` })], { stopReason: 'toolUse', timestamp: 1 });
    };
    faux.setResponses(Array(job.N * 4).fill(response));
  }
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });

  if (mode === 'seed') {
    const records = [];
    for (const id of ids) {
      const cwd = join(root, 'cwds', id);
      mkdirSync(cwd, { recursive: true });
      const opened = await openDurable({ cwd, modelRuntime: runtime });
      let session;
      try {
        await opened.controller.setModel(ref);
        session = opened.view.current().session;
      } finally {
        await opened.close();
      }
      // No native writer remains when public Storage is opened; return only AFTER close.
      const proof = await seedNativeHistory(join(session.directory, 'session.sqlite'), job.history);
      writeFileSync(join(root, `seed-readback-${id}.json`), JSON.stringify({ ...proof, store_closed: true }));
      records.push({ id, cwd, directory: session.directory, nativeSessionId: session.id });
    }
    writeFileSync(join(root, 'seed-records.json'), JSON.stringify(records));
    emit('seed', 'closed', { entries: job.history.length, sessions: records.length, stores_closed: true });
  } else if (mode === 'A') {
    assert(ids.includes(selected));
    const opened = await openDurable({ cwd: join(root, 'cwds', selected), continueSession: true, modelRuntime: runtime });
    try {
      emit(selected, 'ready', { directory: opened.view.current().session.directory });
      await runDurableTui(opened.view, opened.controller, opened.settings);
    } finally {
      await opened.close();
      emit(selected, 'closed');
    }
  } else {
    const host = await createSharedTtyHost({
      controlSocket: process.env.MP_CONTROL, sessionSocket: process.env.MP_SESSION,
      sessions: ids, policy: { maxSessions: job.N },
      hydrate: { root: join(root, 'B-residency'), modelRuntime: runtime }, model: ref,
      onSurface: event => emit(event.sessionId, `surface-${event.type}`, event),
    });
    try {
      emit('host', 'ready');
      await new Promise(done => {
        process.stdin.setEncoding('utf8');
        let input = '';
        process.stdin.on('data', chunk => { input += chunk; if (input === 'STOP\n') done(); });
        process.stdin.on('end', done);
      });
    } finally {
      await host.close();
      assert.equal(host.runtime.control.identities().length, 0);
      emit('host', 'closed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
