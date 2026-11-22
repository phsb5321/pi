// Experimental disk-backed read index for Pi JSONL sessions; never edits the source transcript.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CHUNK_SIZE = 64 * 1024;
const MAX_RECORD = 128 * 1024 * 1024;

function signature(path) {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export class DiskSessionIndex {
  #source;
  #db;
  #signature;
  #closed = false;

  constructor(sessionFile, indexFile = `${sessionFile}.pi-disk-index.sqlite`) {
    this.#source = resolve(sessionFile);
    this.#db = new DatabaseSync(resolve(indexFile));
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA cache_size=-1024;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL
      );
    `);
    this.refresh();
  }

  refresh() {
    this.#assertOpen();
    const before = signature(this.#source);
    const recorded = this.#db.prepare("SELECT value FROM meta WHERE key='source_signature'").get()?.value;
    if (recorded === before) {
      this.#signature = before;
      return { rebuilt: false, entries: this.count() };
    }

    const insert = this.#db.prepare(`INSERT INTO entries(id,parent_id,kind,byte_offset,byte_length)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      parent_id=excluded.parent_id,kind=excluded.kind,
      byte_offset=excluded.byte_offset,byte_length=excluded.byte_length`);
    let counted = 0;
    let ignoredMalformed = 0;
    let bytesReadTotal = 0;
    let startOffset = 0;
    let fragments = [];
    let fragmentBytes = 0;
    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    const consumeLine = (line) => {
      if (!line.length) return;
      try {
        const value = JSON.parse(line.toString('utf8'));
        if (value && typeof value.id === 'string' && typeof value.type === 'string') {
          insert.run(value.id, typeof value.parentId === 'string' ? value.parentId : null,
            value.type, startOffset, line.length);
          counted++;
        } else {
          ignoredMalformed++;
        }
      } catch {
        // Match Pi's loader: malformed lines do not enter the session tree.
        ignoredMalformed++;
      }
    };

    this.#db.exec('BEGIN IMMEDIATE');
    let fd;
    try {
      this.#db.exec('DELETE FROM entries; DELETE FROM meta');
      fd = openSync(this.#source, 'r');
      while (true) {
        const received = readSync(fd, chunk, 0, chunk.length, null);
        if (received === 0) break;
        bytesReadTotal += received;
        for (let pos = 0; pos < received;) {
          const newline = chunk.indexOf(10, pos);
          if (newline < 0 || newline >= received) {
            const part = Buffer.from(chunk.subarray(pos, received));
            fragments.push(part);
            fragmentBytes += part.length;
            if (fragmentBytes > MAX_RECORD) throw new Error('Session line exceeds index safety limit');
            break;
          }
          const part = Buffer.from(chunk.subarray(pos, newline));
          fragments.push(part);
          fragmentBytes += part.length;
          if (fragmentBytes > MAX_RECORD) throw new Error('Session line exceeds index safety limit');
          consumeLine(Buffer.concat(fragments, fragmentBytes));
          startOffset += fragmentBytes + 1;
          fragments = [];
          fragmentBytes = 0;
          pos = newline + 1;
        }
      }
      if (fragmentBytes) consumeLine(Buffer.concat(fragments, fragmentBytes));
      if (signature(this.#source) !== before) {
        throw new Error('Transcript changed while building index; transaction rolled back');
      }
      this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('source_signature', before);
      this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('source_bytes', String(bytesReadTotal));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.#signature = before;
    return { rebuilt: true, entries: counted, ignoredMalformed };
  }

  count() {
    this.#checkFresh();
    return this.#db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  }

  get(id) {
    this.#checkFresh();
    const row = this.#db.prepare('SELECT byte_offset,byte_length FROM entries WHERE id=?').get(id);
    if (!row) return undefined;
    const fd = openSync(this.#source, 'r');
    try {
      const bytes = Buffer.allocUnsafe(row.byte_length);
      const got = readSync(fd, bytes, 0, bytes.length, row.byte_offset);
      if (got !== bytes.length) throw new Error('Transcript changed while reading indexed entry');
      const entry = JSON.parse(bytes.toString('utf8'));
      if (entry.id !== id) throw new Error('Indexed entry identity changed');
      return entry;
    } finally {
      closeSync(fd);
    }
  }

  branch(leafId) {
    this.#checkFresh();
    const rows = [];
    const seen = new Set();
    const find = this.#db.prepare('SELECT parent_id FROM entries WHERE id=? AND kind<>?');
    let id = leafId;
    while (id !== null) {
      if (seen.has(id)) throw new Error(`Session parent cycle at ${id}`);
      seen.add(id);
      const row = find.get(id, 'session');
      if (!row) break;
      rows.push(this.get(id));
      id = row.parent_id;
    }
    rows.reverse();
    return rows;
  }

  page(afterSeq = 0, limit = 100) {
    this.#checkFresh();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid page offset');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid page size');
    const rows = this.#db.prepare('SELECT id,seq FROM entries WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, limit);
    return { nextSeq: rows.at(-1)?.seq ?? afterSeq, entries: rows.map(row => this.get(row.id)) };
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('Disk session index is closed');
  }

  #checkFresh() {
    this.#assertOpen();
    if (this.#signature !== undefined && signature(this.#source) !== this.#signature) {
      throw new Error('Session transcript changed; call refresh before reading');
    }
  }
}
