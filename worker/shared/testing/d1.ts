import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";

import type {
  D1DatabaseCapability,
  D1PreparedStatementCapability,
  D1RowsResultCapability,
  D1RunResultCapability,
} from "../persistence/runDiagnosticsD1.ts";

type BeforeRun = (
  input: Readonly<{ params: readonly unknown[]; sql: string }>,
) => void | Promise<void>;

export type TestD1Options = Readonly<{
  beforeRun?: BeforeRun;
}>;

export type TestD1DatabaseHandle = Readonly<{
  d1: D1DatabaseCapability;
  close(): void;
}>;

const labMigrationSqlStatements = readMigrationSqlStatements(
  new NodeUrl("../../migrations/", import.meta.url),
);

export function createTestLabD1Database(options: TestD1Options = {}): TestD1DatabaseHandle {
  return createTestD1Database(labMigrationSqlStatements, options);
}

/** The SQL of every migration in a folder, in the order D1 applies them. */
export function readMigrationSqlStatements(directoryUrl: NodeUrl): string[] {
  return readdirSync(directoryUrl)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort()
    .map((fileName) => readFileSync(new NodeUrl(fileName, directoryUrl), "utf8"));
}

/** An in-memory database with these migrations applied, behind the D1 capability. */
export function createTestD1Database(
  migrationSqlStatements: readonly string[],
  { beforeRun }: TestD1Options = {},
): TestD1DatabaseHandle {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const migrationSql of migrationSqlStatements) {
    sqlite.exec(migrationSql);
  }

  return {
    d1: new TestD1Database(sqlite, beforeRun),
    close() {
      sqlite.close();
    },
  };
}

class TestD1Database implements D1DatabaseCapability {
  readonly sqlite: DatabaseSync;
  readonly beforeRun: BeforeRun | undefined;

  constructor(sqlite: DatabaseSync, beforeRun: BeforeRun | undefined) {
    this.sqlite = sqlite;
    this.beforeRun = beforeRun;
  }

  prepare(sql: string): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.sqlite, sql, [], this.beforeRun);
  }
}

class TestD1PreparedStatement implements D1PreparedStatementCapability {
  readonly sqlite: DatabaseSync;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly beforeRun: BeforeRun | undefined;

  constructor(
    sqlite: DatabaseSync,
    sql: string,
    params: readonly unknown[] = [],
    beforeRun: BeforeRun | undefined,
  ) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
    this.beforeRun = beforeRun;
  }

  bind(...params: unknown[]): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.sqlite, this.sql, params, this.beforeRun);
  }

  async run(): Promise<D1RunResultCapability> {
    await this.beforeRun?.({ params: this.params, sql: this.sql });
    const result = this.sqlite.prepare(this.sql).run(...readSqliteInputValues(this.params));

    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }

  async all(): Promise<D1RowsResultCapability> {
    return {
      results: this.sqlite.prepare(this.sql).all(...readSqliteInputValues(this.params)),
      success: true,
      meta: {},
    };
  }

  async first(): Promise<Readonly<Record<string, unknown>> | null> {
    return this.sqlite.prepare(this.sql).get(...readSqliteInputValues(this.params)) ?? null;
  }
}

function readSqliteInputValues(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "string" ||
      isSqliteArrayBufferView(value)
    ) {
      return value;
    }

    throw new TypeError("unsupported_test_d1_bind_value");
  });
}

function isSqliteArrayBufferView<Value>(value: Value): value is Value & NodeJS.ArrayBufferView {
  return ArrayBuffer.isView(value);
}
