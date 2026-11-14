import { describe, expect, it } from "vitest";

import { createTestLabD1Database } from "./d1.ts";

describe("Shared D1 test adapter", () => {
  it("loads the Lab migration set", async () => {
    const lab = createTestLabD1Database();

    try {
      await expect(readTable(lab.d1, "lab_runs")).resolves.toEqual({ name: "lab_runs" });
    } finally {
      lab.close();
    }
  });

  it("adapts bind, run, all, and first to the shared D1 capability", async () => {
    const database = createTestLabD1Database();

    try {
      await database.d1
        .prepare("CREATE TABLE d1_helper_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        .run();
      const result = await database.d1
        .prepare("INSERT INTO d1_helper_test (value) VALUES (?)")
        .bind("first")
        .run();

      expect(result.meta?.changes).toBe(1);
      await expect(
        database.d1.prepare("SELECT value FROM d1_helper_test ORDER BY id ASC").all(),
      ).resolves.toMatchObject({
        results: [{ value: "first" }],
        success: true,
      });
      await expect(
        database.d1.prepare("SELECT value FROM d1_helper_test WHERE id = ?").bind(1).first(),
      ).resolves.toEqual({ value: "first" });
    } finally {
      database.close();
    }
  });

  it("observes writes and rejects values unsupported by the SQLite adapter", async () => {
    const writes: Readonly<{ params: readonly unknown[]; sql: string }>[] = [];
    const database = createTestLabD1Database({
      beforeRun: (write) => {
        writes.push(write);
      },
    });

    try {
      await database.d1
        .prepare("DELETE FROM runtime_events WHERE run_id = ?")
        .bind("run_123")
        .run();

      expect(writes).toEqual([
        {
          params: ["run_123"],
          sql: "DELETE FROM runtime_events WHERE run_id = ?",
        },
      ]);
      await expect(database.d1.prepare("SELECT ? AS value").bind({}).all()).rejects.toThrowError(
        "unsupported_test_d1_bind_value",
      );
    } finally {
      database.close();
    }
  });
});

type PreparedDatabase = ReturnType<typeof createTestLabD1Database>["d1"];

async function readTable(
  database: PreparedDatabase,
  tableName: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(tableName)
    .first();
}
