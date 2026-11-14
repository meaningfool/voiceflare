import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { vi } from "vitest";

type TestDurableObjectStorage = {
  sql: TestDurableObjectSql;
  currentAlarm: number | null;
  setAlarm: (scheduledAt: number) => Promise<void>;
  getAlarm: () => Promise<number | null>;
  deleteAlarm: () => Promise<void>;
  transactionSync: <T>(callback: () => T) => T;
};

type SqliteRow = Record<string, SQLOutputValue>;
type TestSqlStorageRow = Record<string, SqlStorageValue>;

export type TestInterviewRuntimeDurableObjectContext = ReturnType<
  typeof createTestDurableObjectContext
>["ctx"];

export function createDurableObjectState(
  ctx: TestInterviewRuntimeDurableObjectContext,
): DurableObjectState {
  const storage = {
    get: unavailableAsync,
    list: unavailableAsync,
    put: unavailableAsync,
    delete: unavailableAsync,
    deleteAll: unavailableAsync,
    transaction: unavailableAsync,
    getAlarm: ctx.storage.getAlarm,
    async setAlarm(scheduledTime: number | Date): Promise<void> {
      await ctx.storage.setAlarm(
        scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime,
      );
    },
    deleteAlarm: ctx.storage.deleteAlarm,
    sync: unavailableAsync,
    sql: ctx.storage.sql,
    get kv(): never {
      return unavailable();
    },
    transactionSync: ctx.storage.transactionSync,
    getCurrentBookmark: unavailableAsync,
    getBookmarkForTime: unavailableAsync,
    onNextSessionRestoreBookmark: unavailableAsync,
  } satisfies DurableObjectStorage;

  return {
    waitUntil(promise: Promise<unknown>): void {
      ctx.waitUntil(promise);
    },
    get exports(): never {
      return unavailable();
    },
    props: undefined,
    get id(): never {
      return unavailable();
    },
    storage,
    get facets(): never {
      return unavailable();
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    acceptWebSocket(_ws: WebSocket, _tags?: string[]): void {},
    getWebSockets(_tag?: string): WebSocket[] {
      return [];
    },
    setWebSocketAutoResponse(_value?: WebSocketRequestResponsePair): void {},
    getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
      return null;
    },
    getWebSocketAutoResponseTimestamp(_ws: WebSocket): Date | null {
      return null;
    },
    setHibernatableWebSocketEventTimeout(_timeoutMs?: number): void {},
    getHibernatableWebSocketEventTimeout(): number | null {
      return null;
    },
    getTags(_ws: WebSocket): string[] {
      return [];
    },
    abort: unavailable,
  };
}

export function createTestDurableObjectContext() {
  const sqlite = new DatabaseSync(":memory:");
  const waitUntilTasks = new Set<Promise<unknown>>();
  const failedWaitUntilTasks = new Set<Promise<unknown>>();
  let transactionDepth = 0;
  const sql = new TestDurableObjectSql(sqlite, () => transactionDepth > 0);
  const storage: TestDurableObjectStorage = {
    sql,
    currentAlarm: null,
    setAlarm: vi.fn(async (scheduledAt: number) => {
      storage.currentAlarm = scheduledAt;
    }),
    getAlarm: vi.fn(async () => storage.currentAlarm),
    deleteAlarm: vi.fn(async () => {
      storage.currentAlarm = null;
    }),
    transactionSync<T>(callback: () => T): T {
      sqlite.exec("BEGIN");
      transactionDepth += 1;
      try {
        const result = callback();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };

  return {
    ctx: {
      storage,
      waitUntil(promise: Promise<unknown>): void {
        const tracked = promise.finally(() => waitUntilTasks.delete(tracked));
        waitUntilTasks.add(tracked);
        // Observe immediately without replacing the rejected retained waiter.
        // Keep settled failures until a later platform flush can report them.
        void tracked.catch(() => failedWaitUntilTasks.add(tracked));
      },
      blockConcurrencyWhile: vi.fn(async (callback: () => Promise<void>) => {
        await callback();
      }),
    },
    storage,
    async flushWaitUntil(): Promise<void> {
      while (waitUntilTasks.size > 0 || failedWaitUntilTasks.size > 0) {
        const tasks = [...waitUntilTasks, ...failedWaitUntilTasks];
        try {
          await Promise.all(tasks);
        } finally {
          for (const task of tasks) failedWaitUntilTasks.delete(task);
        }
      }
    },
    close() {
      sqlite.close();
    },
  };
}

export class TestDurableObjectSql implements SqlStorage {
  readonly sqlite: DatabaseSync;
  readonly executions: Array<Readonly<{ sql: string; inTransaction: boolean }>> = [];
  readonly #isInTransaction: () => boolean;

  constructor(sqlite: DatabaseSync, isInTransaction: () => boolean) {
    this.sqlite = sqlite;
    this.#isInTransaction = isInTransaction;
  }

  get databaseSize(): number {
    return 0;
  }

  get Cursor(): never {
    return unavailable();
  }

  get Statement(): never {
    return unavailable();
  }

  exec<Row extends Record<string, SqlStorageValue>>(
    sql: string,
    ...params: SqlStorageValue[]
  ): SqlStorageCursor<Row>;
  exec(
    sql: string,
    ...params: SqlStorageValue[]
  ): SqlStorageCursor<Record<string, SqlStorageValue>> {
    this.executions.push({ sql, inTransaction: this.#isInTransaction() });
    if (params.length === 0 && !isReadStatement(sql)) {
      this.sqlite.exec(sql);
      return new TestDurableObjectCursor([]);
    }

    const statement = this.sqlite.prepare(sql);
    const bindings = params.map(readSqliteInputValue);
    if (isReadStatement(sql)) {
      return new TestDurableObjectCursor(statement.all(...bindings).map(readSqlStorageRow));
    }
    statement.run(...bindings);
    return new TestDurableObjectCursor([]);
  }
}

class TestDurableObjectCursor<
  Row extends Record<string, SqlStorageValue>,
> implements SqlStorageCursor<Row> {
  readonly rows: Row[];
  private cursor = 0;

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  get columnNames(): string[] {
    return this.rows[0] === undefined ? [] : Object.keys(this.rows[0]);
  }

  get rowsRead(): number {
    return this.rows.length;
  }

  get rowsWritten(): number {
    return 0;
  }

  next(): { done: true; value?: never } | { done?: false; value: Row } {
    const value = this.rows[this.cursor];
    if (value === undefined) return { done: true };
    this.cursor += 1;
    return { done: false, value };
  }

  toArray(): Row[] {
    return this.rows;
  }

  one(): Row {
    if (this.rows.length !== 1) throw new Error("Expected exactly one SQL row.");
    const row = this.rows[0];
    return row === undefined ? unavailable() : row;
  }

  raw<_Values extends SqlStorageValue[]>(): IterableIterator<_Values> {
    return unavailable();
  }

  *[Symbol.iterator](): IterableIterator<Row> {
    while (true) {
      const result = this.next();
      if (result.done) return;
      yield result.value;
    }
  }
}

function unavailable(): never {
  throw new Error("unavailable_test_platform_capability");
}

async function unavailableAsync(): Promise<never> {
  return unavailable();
}

function readSqliteInputValue(value: SqlStorageValue): SQLInputValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function readSqlStorageRow(row: SqliteRow) {
  const normalized: TestSqlStorageRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        throw new TypeError("unsupported_test_durable_object_bigint");
      }
      normalized[key] = number;
      continue;
    }
    if (value instanceof Uint8Array) {
      normalized[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function isReadStatement(sql: string): boolean {
  const operation = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
  return operation === "SELECT" || operation === "PRAGMA";
}
