import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
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

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;

	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
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

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteDatabase> {
	return WorkerSqliteDatabase.open(path, options);
}

/**
 * Runs in one shared worker thread that owns every connection in the process, keyed by database id. Statements run
 * there, so a slow call (fsync on a WAL switch, schema creation, a large commit) never blocks the event loop. One
 * worker, not one per database: starting a thread costs tens of milliseconds and every open paid it. Plain JavaScript,
 * started from a string so source and built output run the same code.
 */
const SQLITE_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const databases = new Map();
function connection(id) {
  const found = databases.get(id);
  if (found === undefined) throw new Error("SQLite database " + id + " is closed");
  return found;
}
function statement(found, sql) {
  let prepared = found.statements.get(sql);
  if (prepared === undefined) {
    prepared = found.database.prepare(sql);
    found.statements.set(sql, prepared);
  }
  return prepared;
}
function perform(op, id, sql, params, options) {
  switch (op) {
    case "open": {
      const database = new DatabaseSync(options.path, { timeout: options.busyTimeoutMs });
      const block = options.testBlockMs;
      if (block > 0) {
        const end = Date.now() + block;
        while (Date.now() < end);
      }
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
      database.exec("PRAGMA wal_autocheckpoint = " + options.checkpointPages);
      databases.set(id, { database, statements: new Map() });
      return undefined;
    }
    case "exec":
      connection(id).database.exec(sql);
      return undefined;
    case "run":
      statement(connection(id), sql).run(...params);
      return undefined;
    case "get":
      return statement(connection(id), sql).get(...params);
    case "all":
      return statement(connection(id), sql).all(...params);
    case "close": {
      const found = databases.get(id);
      if (found !== undefined) {
        databases.delete(id);
        try {
          found.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          found.statements.clear();
          found.database.close();
        }
      }
      return undefined;
    }
    default:
      throw new Error("unknown sqlite worker operation " + op);
  }
}
parentPort.on("message", ({ call, id, op, sql, params, options }) => {
  try {
    parentPort.postMessage({ call, ok: true, result: perform(op, id, sql, params, options) });
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
	readonly result?: unknown;
	readonly error?: { name?: string; message: string; code?: unknown };
};

type OpenOptions = {
	readonly path: string;
	readonly busyTimeoutMs: number;
	readonly checkpointPages: number;
	readonly testBlockMs: number;
};

/** The process-wide SQLite worker. Calls to it settle in the order its replies arrive, keyed by call id. */
class SqliteWorker {
	private static instance: SqliteWorker | undefined;
	private readonly worker: Worker;
	private readonly calls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	private nextCall = 1;
	private nextDatabase = 1;
	private failure: Error | undefined;

	private constructor() {
		this.worker = new Worker(SQLITE_WORKER_SOURCE, { eval: true });
		this.worker.on("message", (reply: WorkerReply) => this.settle(reply));
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", () => this.fail(new Error("SQLite worker exited")));
		// Unreferenced while idle, so an unclosed database cannot keep the process alive.
		this.worker.unref();
	}

	/** The live worker; a crashed one is replaced for databases opened afterwards. */
	static shared(): SqliteWorker {
		if (SqliteWorker.instance === undefined || SqliteWorker.instance.failure !== undefined) {
			SqliteWorker.instance = new SqliteWorker();
		}
		return SqliteWorker.instance;
	}

	newDatabaseId(): number {
		return this.nextDatabase++;
	}

	call(
		op: "open" | "exec" | "run" | "get" | "all" | "close",
		id: number,
		sql?: string,
		params: SqliteValue[] = [],
		options?: OpenOptions,
	): Promise<unknown> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const call = this.nextCall++;
		return new Promise((resolve, reject) => {
			this.calls.set(call, { resolve, reject });
			if (this.calls.size === 1) this.worker.ref();
			this.worker.postMessage({ call, id, op, sql, params, options });
		});
	}

	private settle(reply: WorkerReply): void {
		const pending = this.calls.get(reply.call);
		if (pending === undefined) return;
		this.finish(reply.call);
		if (reply.ok) pending.resolve(reply.result);
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

/** Connection on the shared SQLite worker. Calls are serialized in call order; the queue holds until each settles. */
class WorkerSqliteDatabase implements SqliteDatabase {
	private readonly host: SqliteWorker;
	private readonly id: number;
	private readonly access = new SerialOperationQueue();
	private closed = false;

	private constructor(host: SqliteWorker, id: number) {
		this.host = host;
		this.id = id;
	}

	static async open(path: string, options: NodeSqliteStorageOptions): Promise<WorkerSqliteDatabase> {
		if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		const host = SqliteWorker.shared();
		const id = host.newDatabaseId();
		await host.call("open", id, undefined, [], {
			path,
			busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
			checkpointPages: options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES,
			// Test seam: blocks the worker, not the caller, during the open.
			testBlockMs: Number(process.env.PI_DURABLE_SQLITE_TEST_BLOCK_MS ?? 0),
		});
		return new WorkerSqliteDatabase(host, id);
	}

	exec(sql: string): Promise<void> {
		return this.access.runAsync(() => this.call("exec", sql)) as Promise<void>;
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.access.runAsync(() => this.call("run", sql, params)) as Promise<void>;
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.access.runAsync(() => this.call("get", sql, params)) as Promise<T | undefined>;
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.access.runAsync(() => this.call("all", sql, params)) as Promise<T[]>;
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			await this.call("exec", "BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new WorkerTransaction(this, scope));
				scope.active = false;
				await this.call("exec", "COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					await this.call("exec", "ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.runAsync(async () => {
			if (this.closed) return;
			this.closed = true;
			await this.call("close");
		});
	}

	/** One message to the worker, without the queue. Transactions use it from inside their own queue slot. */
	call(op: "exec" | "run" | "get" | "all" | "close", sql?: string, params: SqliteValue[] = []): Promise<unknown> {
		return this.host.call(op, this.id, sql, params);
	}
}

class WorkerTransaction implements SqliteExecutor {
	private readonly database: WorkerSqliteDatabase;
	private readonly scope: TransactionScope;

	constructor(database: WorkerSqliteDatabase, scope: TransactionScope) {
		this.database = database;
		this.scope = scope;
	}

	exec(sql: string): Promise<void> {
		return this.inScope(() => this.database.call("exec", sql)) as Promise<void>;
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.inScope(() => this.database.call("run", sql, params)) as Promise<void>;
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.inScope(() => this.database.call("get", sql, params)) as Promise<T | undefined>;
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.inScope(() => this.database.call("all", sql, params)) as Promise<T[]>;
	}

	private inScope(operation: () => Promise<unknown>): Promise<unknown> {
		if (!this.scope.active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
		return operation();
	}
}

/** Open or create file-backed durable storage using Node's built-in SQLite. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(await openNodeSqliteDatabase(path, options));
}
