import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import { SqliteStorage } from "./storage.ts";

/** Node SQLite connection settings for a durable storage file. */
export type NodeSqliteStorageOptions = {
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

type TransactionScope = { active: boolean };

const ignore = (): void => {};

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or waiting;
 * otherwise it waits for everything before it. An asynchronous operation holds the queue until it settles.
 */
class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		// Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}

	private release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

/**
 * Executes SQL on one connection. Prepared statements are cached per connection by SQL text, so the
 * database and its transaction handles share them across transactions.
 */
abstract class NodeSqliteExecutor implements SqliteExecutor {
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params);
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
	private readonly scope: TransactionScope;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}

	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

/** Work the main thread must not run synchronously: the fsync-bound WAL switch and checkpoints. */
type MaintenanceHooks = {
	/** Awaited by the committing caller after COMMIT. Waits for a checkpoint only past the WAL threshold. */
	afterCommit(): Promise<void>;
	/** Runs after the main connection is closed; resolves once maintenance has finished. */
	close(): Promise<void>;
};

/**
 * `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. Statements run on the calling thread: a WAL-mode
 * COMMIT with `synchronous=NORMAL` does not fsync, so the main thread only pays for appends. Checkpoints (which do
 * fsync) run on the shared worker through `hooks` when the database is opened by `openNodeSqliteDatabase`.
 */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private readonly hooks: MaintenanceHooks | undefined;
	private closed = false;

	constructor(database: DatabaseSync, hooks?: MaintenanceHooks) {
		super(database, new Map());
		this.hooks = hooks;
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			let result: T;
			try {
				result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
			// Outside the try: the transaction is committed, so a hook failure must not roll it back.
			await this.hooks?.afterCommit();
			return result;
		});
	}

	close(): Promise<void> {
		return this.access.runAsync(async () => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				// Without hooks (a caller-owned connection) the final checkpoint stays on this thread, as before.
				if (this.hooks === undefined) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
			await this.hooks?.close();
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

function workerError(info: { name?: string; message: string; code?: unknown } | undefined): Error {
	const error = new Error(info?.message ?? "SQLite worker failed");
	if (info?.name !== undefined) error.name = info.name;
	if (info?.code !== undefined) Object.assign(error, { code: info.code });
	return error;
}

/**
 * Runs in one shared worker thread. It only does the blocking phases: `prepare` switches a file to WAL before any main
 * connection opens; `checkpoint` and `release` run checkpoints on their own short-lived connections. Statements never
 * come here. Plain JavaScript, started from a string so source and built output run the same code.
 */
const SQLITE_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
function connect(path, options) {
  return new DatabaseSync(path, { timeout: options.busyTimeoutMs });
}
function perform(op, path, options) {
  switch (op) {
    case "prepare": {
      const database = connect(path, options);
      try {
        const block = options.testBlockMs;
        if (block > 0) {
          const end = Date.now() + block;
          while (Date.now() < end);
        }
        database.exec("PRAGMA journal_mode = WAL");
      } finally {
        database.close();
      }
      return undefined;
    }
    case "checkpoint":
    case "release": {
      const database = connect(path, options);
      try {
        database.exec("PRAGMA wal_checkpoint(" + options.mode + ")");
      } finally {
        database.close();
      }
      return undefined;
    }
    default:
      throw new Error("unknown sqlite worker operation " + op);
  }
}
parentPort.on("message", ({ call, op, path, options }) => {
  try {
    parentPort.postMessage({ call, ok: true, result: perform(op, path, options) });
  } catch (error) {
    parentPort.postMessage({
      call,
      ok: false,
      error: { name: error?.name, message: error?.message ?? String(error), code: error?.code },
    });
  }
});
`;

type WorkerReply = {
	readonly call: number;
	readonly ok: boolean;
	readonly error?: { name?: string; message: string; code?: unknown };
};

type WorkerOptions = {
	readonly busyTimeoutMs: number;
	readonly testBlockMs?: number;
	readonly mode?: "PASSIVE" | "TRUNCATE";
};

/** The process-wide SQLite worker. Replies settle the call they name, so concurrent callers do not interfere. */
class SqliteWorker {
	private static instance: SqliteWorker | undefined;
	private readonly worker: Worker;
	private readonly calls = new Map<number, { resolve(): void; reject(error: unknown): void }>();
	private nextCall = 1;
	private failure: Error | undefined;

	private constructor() {
		this.worker = new Worker(SQLITE_WORKER_SOURCE, { eval: true });
		this.worker.on("message", (reply: WorkerReply) => this.settle(reply));
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", () => this.fail(new Error("SQLite worker exited")));
		// Unreferenced while idle, so an unclosed database cannot keep the process alive.
		this.worker.unref();
	}

	/** The live worker; a crashed one is replaced for calls made afterwards. */
	static shared(): SqliteWorker {
		if (SqliteWorker.instance === undefined || SqliteWorker.instance.failure !== undefined) {
			SqliteWorker.instance = new SqliteWorker();
		}
		return SqliteWorker.instance;
	}

	call(op: "prepare" | "checkpoint" | "release", path: string, options: WorkerOptions): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const call = this.nextCall++;
		return new Promise((resolve, reject) => {
			this.calls.set(call, { resolve, reject });
			if (this.calls.size === 1) this.worker.ref();
			this.worker.postMessage({ call, op, path, options });
		});
	}

	private settle(reply: WorkerReply): void {
		const pending = this.calls.get(reply.call);
		if (pending === undefined) return;
		this.finish(reply.call);
		if (reply.ok) pending.resolve();
		else pending.reject(workerError(reply.error));
	}

	private fail(error: Error): void {
		if (this.failure === undefined) this.failure = error;
		for (const call of [...this.calls.keys()]) {
			const pending = this.calls.get(call)!;
			this.finish(call);
			pending.reject(this.failure);
		}
	}

	private finish(call: number): void {
		this.calls.delete(call);
		if (this.calls.size === 0) this.worker.unref();
	}
}

/**
 * Checkpoint policy for a file database whose main connection runs `wal_autocheckpoint=0`. After a commit, if the WAL is
 * past `checkpointPages`, the committing caller waits for a PASSIVE checkpoint on the worker. The wait is an `await`, so
 * the event loop keeps running; only that caller sees the latency. A failed background checkpoint is kept and rethrown
 * at close, so it is not lost. At close a TRUNCATE checkpoint runs on the worker too.
 */
class WorkerCheckpoints implements MaintenanceHooks {
	private readonly host: SqliteWorker;
	private readonly path: string;
	private readonly options: WorkerOptions;
	private readonly thresholdBytes: number;
	private inFlight: Promise<void> | undefined;
	private failure: unknown;

	constructor(host: SqliteWorker, path: string, options: WorkerOptions, checkpointPages: number) {
		this.host = host;
		this.path = path;
		this.options = options;
		this.thresholdBytes = checkpointPages * 4096;
	}

	async afterCommit(): Promise<void> {
		if (this.thresholdBytes === 0) return;
		const wal = statSync(`${this.path}-wal`, { throwIfNoEntry: false });
		if ((wal?.size ?? 0) < this.thresholdBytes) return;
		this.inFlight ??= this.host
			.call("checkpoint", this.path, { ...this.options, mode: "PASSIVE" })
			.catch((error: unknown) => {
				this.failure ??= error;
			})
			.finally(() => {
				this.inFlight = undefined;
			});
		await this.inFlight;
	}

	async close(): Promise<void> {
		await this.inFlight;
		if (this.failure !== undefined) throw this.failure;
		await this.host.call("release", this.path, { ...this.options, mode: "TRUNCATE" });
	}
}

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (path === ":memory:") {
		const adapter = new NodeSqliteDatabase(new DatabaseSync(path, { timeout }));
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		return adapter;
	}
	await mkdir(dirname(path), { recursive: true });
	const host = SqliteWorker.shared();
	// Test seam: blocks the worker, not the caller, during the WAL switch.
	const worker: WorkerOptions = {
		busyTimeoutMs: timeout,
		testBlockMs: Number(process.env.PI_DURABLE_SQLITE_TEST_BLOCK_MS ?? 0),
	};
	// The WAL switch fsyncs a fresh file. It runs on the worker and finishes before the main connection opens, so the
	// two never hold the file at once and the main connection opens an already-WAL file.
	await host.call("prepare", path, worker);
	const hooks = new WorkerCheckpoints(host, path, { busyTimeoutMs: timeout }, checkpointPages);
	const adapter = new NodeSqliteDatabase(new DatabaseSync(path, { timeout }), hooks);
	try {
		await adapter.exec("PRAGMA synchronous = NORMAL");
		// Automatic checkpoints fsync on the calling thread; the worker runs them instead (see WorkerCheckpoints).
		await adapter.exec("PRAGMA wal_autocheckpoint = 0");
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}

/** Open or create file-backed durable storage using Node's built-in SQLite. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(await openNodeSqliteDatabase(path, options));
}
