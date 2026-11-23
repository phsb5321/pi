/**
 * Opt-in disk index over a Pi session JSONL transcript (PI_SESSION_DISK_INDEX=1).
 *
 * The JSONL file stays the only source of truth. This index is derived data: a SQLite file that maps
 * entry id -> byte range, so SessionManager can hold a handful of entries instead of the whole history.
 * It is disposable: any failure here makes SessionManager fall back to the eager in-memory load.
 *
 * Safety model (derived from the GPT "prefix-safe v3" candidate):
 *  - the transcript is never modified, except for the same trailing-newline repair the eager loader does;
 *  - appends made through this class are single-writer: the new line is recorded at the known offset and only the
 *    touched 1 MiB blocks are re-hashed, so an append costs O(new bytes), not O(history);
 *  - any other change (foreign append, rewrite, truncation) is detected by the file signature, and the next read
 *    verifies the hashed prefix blocks before extending incrementally, or rebuilds from scratch;
 *  - a read re-validates the entry id, so bytes from a stale offset are never returned as another entry.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { FileEntry, SessionEntry } from "./session-manager.ts";

const CHUNK_SIZE = 64 * 1024;
const BLOCK_SIZE = 1024 * 1024;
const MAX_RECORD = 128 * 1024 * 1024;
const ENTRY_CACHE_SIZE = 256;
const CHANGED_WHILE_INDEXING = "Transcript changed while indexing";

export const SESSION_DISK_INDEX_ENV = "PI_SESSION_DISK_INDEX";
export const SESSION_DISK_INDEX_DIR_ENV = "PI_SESSION_DISK_INDEX_DIR";

export function isSessionDiskIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[SESSION_DISK_INDEX_ENV];
	return value === "1" || value === "true";
}

/** Where the derived index for a transcript lives. Never inside the sessions directory. */
export function sessionDiskIndexPath(
	sessionFile: string,
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const dir = env[SESSION_DISK_INDEX_DIR_ENV] || join(agentDir, "session-index");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${createHash("sha256").update(sessionFile).digest("hex").slice(0, 32)}.sqlite`);
}

let sqliteModule: typeof import("node:sqlite") | undefined;

/** node:sqlite prints an ExperimentalWarning on first load; keep that out of the TUI for this one message. */
function loadSqlite(): typeof import("node:sqlite") {
	if (sqliteModule) return sqliteModule;
	const original = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (/SQLite is an experimental feature/.test(text)) return;
		return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	} finally {
		process.emitWarning = original;
	}
	return sqliteModule;
}

function signatureOf(path: string): string {
	const stat = statSync(path, { bigint: true });
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function sizeFromSignature(signature: string): number {
	return Number(signature.split(":")[2]);
}

function sameFileFromSignatures(a: string, b: string): boolean {
	const x = a.split(":");
	const y = b.split(":");
	return x[0] === y[0] && x[1] === y[1];
}

/** SHA-256 of [start, end) of the file. */
function hashRange(fd: number, start: number, end: number): string {
	const hash = createHash("sha256");
	const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
	let offset = start;
	while (offset < end) {
		const got = readSync(fd, chunk, 0, Math.min(CHUNK_SIZE, end - offset), offset);
		if (got === 0) throw new Error("Transcript shortened while hashing");
		hash.update(chunk.subarray(0, got));
		offset += got;
	}
	return hash.digest("hex");
}

export interface DiskIndexRefresh {
	strategy: "unchanged" | "append" | "rebuild";
	entries: number;
	/** Bytes scanned by this refresh (0 when unchanged). */
	scannedBytes: number;
}

export interface PathRow {
	id: string;
	kind: string;
	role: string | null;
}

interface Row {
	byte_offset: number;
	byte_length: number;
}

export class SessionDiskIndex {
	private readonly source: string;
	private readonly db: DatabaseSync;
	private signature = "";
	private closed = false;
	/** Bumps whenever the index was rebuilt from scratch, i.e. row sequence numbers no longer continue the old ones. */
	epoch = 0;
	private readonly cache = new Map<string, SessionEntry>();
	private readonly stmts: Record<string, StatementSync> = {};

	private constructor(source: string, indexFile: string) {
		this.source = source;
		const { DatabaseSync: Database } = loadSqlite();
		this.db = new Database(indexFile);
		this.db.exec(`
			PRAGMA busy_timeout=5000;
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA cache_size=-1024;
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS blocks (n INTEGER PRIMARY KEY, sha TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS entries (
				seq INTEGER PRIMARY KEY,
				id TEXT UNIQUE NOT NULL,
				parent_id TEXT,
				kind TEXT NOT NULL,
				role TEXT,
				byte_offset INTEGER NOT NULL,
				byte_length INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent_id);
			CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind, seq);
		`);
	}

	/** Opens (and refreshes) the index. Throws on any problem; the caller must fall back to the eager load. */
	static open(sessionFile: string, indexFile: string): SessionDiskIndex {
		const index = new SessionDiskIndex(sessionFile, indexFile);
		try {
			index.refresh();
		} catch (error) {
			index.close();
			throw error;
		}
		return index;
	}

	private stmt(sql: string): StatementSync {
		let s = this.stmts[sql];
		if (!s) {
			s = this.db.prepare(sql);
			this.stmts[sql] = s;
		}
		return s;
	}

	private meta(key: string): string | undefined {
		return (this.stmt("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
	}

	private setMeta(key: string, value: string): void {
		this.stmt("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
			key,
			value,
		);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Session disk index is closed");
	}

	/** Re-hashes blocks [fromBlock, end of file) and stores them. */
	private storeBlocks(fd: number, fromBlock: number, size: number): void {
		const put = this.stmt("INSERT INTO blocks(n,sha) VALUES(?,?) ON CONFLICT(n) DO UPDATE SET sha=excluded.sha");
		for (let n = fromBlock; n * BLOCK_SIZE < size; n++) {
			put.run(n, hashRange(fd, n * BLOCK_SIZE, Math.min((n + 1) * BLOCK_SIZE, size)));
		}
		this.stmt("DELETE FROM blocks WHERE n>=?").run(Math.max(Math.ceil(size / BLOCK_SIZE), fromBlock));
	}

	/** True when every recorded block of the first `bytes` bytes still matches the file. */
	private prefixIntact(fd: number, bytes: number): boolean {
		const get = this.stmt("SELECT sha FROM blocks WHERE n=?");
		for (let n = 0; n * BLOCK_SIZE < bytes; n++) {
			const expected = (get.get(n) as { sha: string } | undefined)?.sha;
			if (!expected || hashRange(fd, n * BLOCK_SIZE, Math.min((n + 1) * BLOCK_SIZE, bytes)) !== expected)
				return false;
		}
		return true;
	}

	/**
	 * Brings the index in line with the file. Unchanged signature: no read. Same file, longer, hashed prefix intact
	 * and ending in a newline: scans only the new bytes. Anything else: full rebuild.
	 */
	refresh(): DiskIndexRefresh {
		this.assertOpen();
		const before = signatureOf(this.source);
		const recorded = this.meta("source_signature");
		if (recorded === before) {
			this.signature = before;
			return { strategy: "unchanged", entries: this.count(), scannedBytes: 0 };
		}
		const oldBytes = Number(this.meta("source_bytes"));
		const newBytes = sizeFromSignature(before);
		const fd = openSync(this.source, "r");
		try {
			const incremental =
				recorded !== undefined &&
				this.meta("source_ends_newline") === "1" &&
				Number.isSafeInteger(oldBytes) &&
				oldBytes >= 0 &&
				newBytes > oldBytes &&
				sameFileFromSignatures(recorded, before) &&
				this.prefixIntact(fd, oldBytes);
			return this.scan(fd, before, incremental ? oldBytes : 0, incremental);
		} finally {
			closeSync(fd);
		}
	}

	private scan(fd: number, before: string, startAt: number, incremental: boolean): DiskIndexRefresh {
		const insert = this.stmt(
			"INSERT OR IGNORE INTO entries(id,parent_id,kind,role,byte_offset,byte_length) VALUES(?,?,?,?,?,?)",
		);
		let duplicates = incremental ? Number(this.meta("duplicates") ?? 0) : 0;
		let unindexable = incremental ? Number(this.meta("unindexable") ?? 0) : 0;
		let lineStart = startAt;
		let fragments: Buffer[] = [];
		let fragmentBytes = 0;
		const consume = (line: Buffer): void => {
			if (line.length === 0 || line.toString("utf8").trim() === "") return;
			let value: unknown;
			try {
				value = JSON.parse(line.toString("utf8"));
			} catch {
				return; // malformed lines are skipped by the eager loader too
			}
			const entry = value as {
				id?: unknown;
				type?: unknown;
				parentId?: unknown;
				message?: { role?: unknown };
			} | null;
			if (!entry || typeof entry.id !== "string" || typeof entry.type !== "string") {
				unindexable++; // valid JSON the eager loader would keep but this index cannot address
				return;
			}
			const result = insert.run(
				entry.id,
				typeof entry.parentId === "string" ? entry.parentId : null,
				entry.type,
				typeof entry.message?.role === "string" ? entry.message.role : null,
				lineStart,
				line.length,
			);
			if (Number(result.changes) === 0) duplicates++;
		};

		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!incremental) this.db.exec("DELETE FROM entries; DELETE FROM meta; DELETE FROM blocks");
			const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
			let offset = startAt;
			for (;;) {
				const received = readSync(fd, chunk, 0, chunk.length, offset);
				if (received === 0) break;
				offset += received;
				for (let pos = 0; pos < received; ) {
					const newline = chunk.indexOf(10, pos);
					const lineEnds = newline >= 0 && newline < received;
					const part = Buffer.from(chunk.subarray(pos, lineEnds ? newline : received));
					fragments.push(part);
					fragmentBytes += part.length;
					if (fragmentBytes > MAX_RECORD) throw new Error("Session line exceeds the index safety limit");
					if (!lineEnds) break;
					consume(Buffer.concat(fragments, fragmentBytes));
					lineStart += fragmentBytes + 1;
					fragments = [];
					fragmentBytes = 0;
					pos = newline + 1;
				}
			}
			const endsInNewline = fragmentBytes === 0;
			if (fragmentBytes > 0) consume(Buffer.concat(fragments, fragmentBytes));
			if (signatureOf(this.source) !== before) throw new Error(CHANGED_WHILE_INDEXING);
			this.storeBlocks(fd, Math.floor(startAt / BLOCK_SIZE), offset);
			this.setMeta("source_signature", before);
			this.setMeta("source_bytes", String(offset));
			this.setMeta("source_ends_newline", endsInNewline ? "1" : "0");
			this.setMeta("duplicates", String(duplicates));
			this.setMeta("unindexable", String(unindexable));
			this.db.exec("COMMIT");
			this.signature = before;
			this.cache.clear();
			if (!incremental) this.epoch++;
			return { strategy: incremental ? "append" : "rebuild", entries: this.count(), scannedBytes: offset - startAt };
		} catch (error) {
			this.rollback();
			throw error;
		}
	}

	/** Why this transcript cannot be served lazily with the eager loader's exact semantics, or undefined. */
	incompatibility(): string | undefined {
		this.assertOpen();
		if (Number(this.meta("duplicates") ?? 0) > 0) return "duplicate entry ids";
		if (Number(this.meta("unindexable") ?? 0) > 0) return "entries without id/type";
		return undefined;
	}

	endsInNewline(): boolean {
		return this.meta("source_ends_newline") === "1";
	}

	/** Same repair as the eager loader: terminate a final unterminated line, then index again. */
	repairTrailingNewline(): void {
		if (this.endsInNewline()) return;
		appendFileSync(this.source, "\n");
		this.refresh();
	}

	count(): number {
		this.assertOpen();
		return Number((this.stmt("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
	}

	/** Re-syncs with the file if something else changed it since the last refresh. */
	refreshIfStale(): void {
		this.ensureFresh();
	}

	private ensureFresh(): void {
		this.assertOpen();
		// A live writer can append while a scan runs; the scan then reports a changed file. Try again a few times.
		for (let attempt = 1; signatureOf(this.source) !== this.signature; attempt++) {
			try {
				this.refresh();
				return;
			} catch (error) {
				if (attempt >= 3 || !(error instanceof Error) || error.message !== CHANGED_WHILE_INDEXING) throw error;
			}
		}
	}

	private readRecord(row: Row, id: string, openFd?: number): FileEntry | undefined {
		const fd = openFd ?? openSync(this.source, "r");
		try {
			const bytes = Buffer.allocUnsafe(row.byte_length);
			if (readSync(fd, bytes, 0, bytes.length, row.byte_offset) !== bytes.length) return undefined;
			const value = JSON.parse(bytes.toString("utf8")) as FileEntry;
			return (value as { id?: unknown }).id === id ? value : undefined;
		} catch {
			return undefined;
		} finally {
			if (openFd === undefined) closeSync(fd);
		}
	}

	private remember(entry: SessionEntry): void {
		this.cache.delete(entry.id);
		this.cache.set(entry.id, entry);
		if (this.cache.size > ENTRY_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
	}

	/** The first (header) record, or undefined if the first indexed row is not a session header. */
	header(): FileEntry | undefined {
		this.ensureFresh();
		const row = this.stmt("SELECT id, byte_offset, byte_length, kind FROM entries ORDER BY seq LIMIT 1").get() as
			| (Row & { id: string; kind: string })
			| undefined;
		if (!row || row.kind !== "session") return undefined;
		return this.readRecord(row, row.id);
	}

	has(id: string): boolean {
		this.ensureFresh();
		return (
			this.cache.has(id) ||
			this.stmt("SELECT 1 AS x FROM entries WHERE id=? AND kind<>'session'").get(id) !== undefined
		);
	}

	get(id: string): SessionEntry | undefined {
		this.ensureFresh();
		const hit = this.cache.get(id);
		if (hit) return hit;
		const row = this.stmt("SELECT byte_offset, byte_length FROM entries WHERE id=? AND kind<>'session'").get(id) as
			| Row
			| undefined;
		if (!row) return undefined;
		const entry = this.readRecord(row, id) as SessionEntry | undefined;
		if (entry) this.remember(entry);
		return entry;
	}

	private idOnly(sql: string, ...args: string[]): string | null {
		const row = this.stmt(sql).get(...args) as { id: string } | undefined;
		return row?.id ?? null;
	}

	/** Id of the last non-header entry in file order (the leaf an eager load would pick). */
	lastId(): string | null {
		this.ensureFresh();
		return this.idOnly("SELECT id FROM entries WHERE kind<>'session' ORDER BY seq DESC LIMIT 1");
	}

	/** Last non-header entry of a given type (e.g. session_info). */
	lastOfKind(kind: string): SessionEntry | undefined {
		this.ensureFresh();
		const id = this.idOnly("SELECT id FROM entries WHERE kind=? ORDER BY seq DESC LIMIT 1", kind);
		return id === null ? undefined : this.get(id);
	}

	/** Direct children in file order. */
	children(parentId: string): SessionEntry[] {
		this.ensureFresh();
		const rows = this.stmt("SELECT id FROM entries WHERE parent_id=? AND kind<>'session' ORDER BY seq").all(
			parentId,
		) as Array<{ id: string }>;
		return rows.flatMap((row) => {
			const entry = this.get(row.id);
			return entry ? [entry] : [];
		});
	}

	/** Non-header entries in file order, read one at a time. `afterSeq` resumes a previous pass. */
	*iterate(afterSeq = 0): Generator<{ seq: number; entry: SessionEntry }> {
		this.ensureFresh();
		let cursor = afterSeq;
		const page = this.stmt(
			"SELECT seq, id, byte_offset, byte_length FROM entries WHERE seq>? AND kind<>'session' ORDER BY seq LIMIT 256",
		);
		const fd = openSync(this.source, "r");
		try {
			for (;;) {
				const rows = page.all(cursor) as unknown as Array<Row & { seq: number; id: string }>;
				if (rows.length === 0) return;
				for (const row of rows) {
					cursor = row.seq;
					const entry = this.readRecord(row, row.id, fd) as SessionEntry | undefined;
					if (entry) yield { seq: row.seq, entry };
				}
			}
		} finally {
			closeSync(fd);
		}
	}

	/** All entries of one type in file order (labels are resolved from these at open). */
	*entriesOfKind(kind: string): Generator<SessionEntry> {
		this.ensureFresh();
		const rows = this.stmt("SELECT id, byte_offset, byte_length FROM entries WHERE kind=? ORDER BY seq").all(
			kind,
		) as unknown as Array<Row & { id: string }>;
		for (const row of rows) {
			const entry = this.readRecord(row, row.id) as SessionEntry | undefined;
			if (entry) yield entry;
		}
	}

	/**
	 * Root-to-leaf chain of `leafId` as row metadata only (no JSON is read). The walk stops at a missing parent and
	 * cannot loop: it is bounded by the number of rows.
	 */
	pathMeta(leafId: string): PathRow[] {
		this.ensureFresh();
		const rows = this.stmt(`
			WITH RECURSIVE chain(id, parent_id, kind, role, depth) AS (
				SELECT id, parent_id, kind, role, 0 FROM entries WHERE id=? AND kind<>'session'
				UNION ALL
				SELECT e.id, e.parent_id, e.kind, e.role, chain.depth+1 FROM entries e JOIN chain ON e.id=chain.parent_id
				WHERE e.kind<>'session' AND chain.depth < ?
			)
			SELECT id, kind, role FROM chain ORDER BY depth DESC`).all(leafId, this.count()) as unknown as PathRow[];
		return rows;
	}

	/** Reads several entries with one open file. Missing or changed entries are skipped. */
	getMany(ids: string[]): SessionEntry[] {
		this.ensureFresh();
		const find = this.stmt("SELECT byte_offset, byte_length FROM entries WHERE id=? AND kind<>'session'");
		const fd = openSync(this.source, "r");
		try {
			const out: SessionEntry[] = [];
			for (const id of ids) {
				const hit = this.cache.get(id);
				if (hit) {
					out.push(hit);
					continue;
				}
				const row = find.get(id) as Row | undefined;
				const entry = row ? (this.readRecord(row, id, fd) as SessionEntry | undefined) : undefined;
				if (entry) out.push(entry);
			}
			return out;
		} finally {
			closeSync(fd);
		}
	}

	/** Highest seq of a non-header entry (0 when none). */
	lastSeq(): number {
		this.ensureFresh();
		return Number(
			(this.stmt("SELECT COALESCE(MAX(seq),0) AS s FROM entries WHERE kind<>'session'").get() as { s: number }).s,
		);
	}

	/**
	 * Single-writer append. Writes one JSONL line and records it at its known offset without re-reading history.
	 * If something else changed the file since the last refresh, re-sync first (and newline-terminate a partial line).
	 */
	append(entry: SessionEntry): void {
		this.ensureFresh();
		if (!this.endsInNewline()) {
			appendFileSync(this.source, "\n");
			this.refresh();
		}
		const line = `${JSON.stringify(entry)}\n`;
		const offset = Number(this.meta("source_bytes"));
		appendFileSync(this.source, line);
		const length = Buffer.byteLength(line) - 1;
		const after = signatureOf(this.source);
		this.remember(entry);
		if (sizeFromSignature(after) !== offset + length + 1) return; // someone else wrote too: the next read refreshes
		// The line is already in the transcript, which is the source of truth. If the index is busy (another process
		// holds the database) or fails, keep the entry and leave `signature` stale: the next read re-syncs by scanning.
		try {
			this.record(entry, offset, length, after);
		} catch (error) {
			this.deferredSyncError = error;
		}
	}

	/** Last index write that was deferred to the next read because the database was busy or failed. */
	deferredSyncError: unknown;

	private record(entry: SessionEntry, offset: number, length: number, after: string): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.stmt(
				"INSERT OR IGNORE INTO entries(id,parent_id,kind,role,byte_offset,byte_length) VALUES(?,?,?,?,?,?)",
			).run(
				entry.id,
				typeof entry.parentId === "string" ? entry.parentId : null,
				entry.type,
				entry.type === "message" ? entry.message.role : null,
				offset,
				length,
			);
			if (Number(result.changes) === 0) this.setMeta("duplicates", String(Number(this.meta("duplicates") ?? 0) + 1));
			const fd = openSync(this.source, "r");
			try {
				this.storeBlocks(fd, Math.floor(offset / BLOCK_SIZE), offset + length + 1);
			} finally {
				closeSync(fd);
			}
			this.setMeta("source_signature", after);
			this.setMeta("source_bytes", String(offset + length + 1));
			this.db.exec("COMMIT");
			this.signature = after;
			this.deferredSyncError = undefined;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}

	private rollback(): void {
		if (this.db.isTransaction) this.db.exec("ROLLBACK");
	}

	exists(): boolean {
		return existsSync(this.source);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cache.clear();
		this.db.close();
	}
}

/** The subset of Map that SessionManager uses for its id lookup. Backed by the disk index when lazy. */
export interface SessionEntryLookup {
	get(id: string): SessionEntry | undefined;
	has(id: string): boolean;
	set(id: string, entry: SessionEntry): unknown;
	clear(): void;
	values(): IterableIterator<SessionEntry>;
}

export class IndexedEntryLookup implements SessionEntryLookup {
	private readonly index: SessionDiskIndex;

	constructor(index: SessionDiskIndex) {
		this.index = index;
	}

	get(id: string): SessionEntry | undefined {
		return this.index.get(id);
	}

	has(id: string): boolean {
		return this.index.has(id);
	}

	/** Appends reach the index through SessionDiskIndex.append; nothing to store here. */
	set(): this {
		return this;
	}

	clear(): void {}

	*values(): IterableIterator<SessionEntry> {
		for (const { entry } of this.index.iterate()) yield entry;
	}
}
