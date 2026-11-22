// Deterministic, offline contract tests for the experimental Pi disk session index.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiskSessionIndex } from './disk-session-index.mjs';

const header = { type: 'session', id: 's', cwd: '/tmp/test', version: 3 };
const a = { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'áé🦊' } };
const b = { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: 'B'.repeat(99) } };
const c = { type: 'custom', id: 'c', parentId: 'b', customType: 'state', data: { x: 2 } };
const fork = { type: 'message', id: 'f', parentId: 'a', message: { role: 'user', content: 'branch' } };

function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-disk-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, content);
  return file;
}

test('complete entries, UTF-8 offsets, branches, pagination and restart', (t) => {
  const lines = [header, a, b, c, fork].map(x => JSON.stringify(x)).join('\n') + '\n';
  const file = fixture(t, lines);
  const idx = new DiskSessionIndex(file);
  assert.equal(idx.count(), 5);
  assert.deepEqual(idx.get('a'), a);
  assert.deepEqual(idx.get('c'), c);
  assert.equal(idx.get('missing'), undefined);
  assert.deepEqual(idx.branch('c'), [a, b, c]);
  assert.deepEqual(idx.branch('f'), [a, fork]);
  let page = idx.page(0, 2);
  assert.deepEqual(page.entries, [header, a]);
  page = idx.page(page.nextSeq, 3);
  assert.deepEqual(page.entries, [b, c, fork]);
  assert.deepEqual(idx.branch('s'), []);
  idx.close();
  const reopened = new DiskSessionIndex(file);
  assert.equal(reopened.refresh().rebuilt, false);
  assert.deepEqual(reopened.get('f'), fork);
  reopened.close();
});

test('freshness guard detects append, refresh picks up new exact data', (t) => {
  const file = fixture(t, [header, a].map(x => JSON.stringify(x)).join('\n') + '\n');
  const idx = new DiskSessionIndex(file);
  appendFileSync(file, JSON.stringify(b) + '\n');
  assert.throws(() => idx.get('a'), /changed/);
  assert.equal(idx.refresh().rebuilt, true);
  assert.deepEqual(idx.get('b'), b);
  idx.close();
});

test('malformed JSONL records are ignored without altering canonical transcript', (t) => {
  const raw = JSON.stringify(header) + '\nINVALID{' + '\n' + JSON.stringify(a);
  const file = fixture(t, raw);
  const idx = new DiskSessionIndex(file);
  assert.equal(idx.count(), 2);
  assert.equal(readFileSync(file, 'utf8'), raw);
  assert.deepEqual(idx.get('a'), a);
  idx.close();
});

test('separate sessions and indexed identities remain isolated', (t) => {
  const aFile = fixture(t, JSON.stringify(header) + '\n' + JSON.stringify(a) + '\n');
  const bFile = fixture(t, JSON.stringify({ type: 'session', id: 'z' }) + '\n');
  const left = new DiskSessionIndex(aFile);
  const right = new DiskSessionIndex(bFile);
  assert.deepEqual(left.get('a'), a);
  assert.equal(right.get('a'), undefined);
  assert.equal(right.count(), 1);
  left.close();right.close();
});

test('cycle is rejected, not interpreted as a valid branch', (t) => {
  const cycle = { type: 'message', id: 'x', parentId: 'x', message: { role: 'user', content: 'x' } };
  const file = fixture(t, [header, cycle].map(x => JSON.stringify(x)).join('\n'));
  const idx = new DiskSessionIndex(file);
  assert.throws(() => idx.branch('x'), /cycle/);
  idx.close();
});

test('large line spanning multiple read chunks preserves exact byte offsets', (t) => {
  const large = { type: 'message', id: 'large', parentId: null, message: { role: 'user', content: 'õ'.repeat(120000) } };
  const file = fixture(t, [header, large, b].map(x => JSON.stringify(x)).join('\n') + '\n');
  const idx = new DiskSessionIndex(file);
  assert.deepEqual(idx.get('large'), large);
  assert.deepEqual(idx.get('b'), b);
  idx.close();
});

test('invalid access after close and bounded page sizes fail closed', (t) => {
  const file = fixture(t, JSON.stringify(header) + '\n');
  const idx = new DiskSessionIndex(file);
  assert.throws(() => idx.page(0, 1001), /Invalid page size/);
  idx.close();
  assert.throws(() => idx.count(), /closed/);
});
