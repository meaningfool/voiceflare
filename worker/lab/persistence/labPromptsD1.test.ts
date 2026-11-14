import { describe, expect, it } from "vitest";
import { promptLibrarySeed } from "../../../src/apps/lab/content/promptLibrary.ts";
import { createTestLabD1Database } from "../../shared/testing/d1.ts";
import { decodePromptRow, listLabPrompts, type LabPrompt } from "./labPromptsD1.ts";
import { labWorkerTestHarness } from "../../lab.ts";

const byId = (prompts: readonly LabPrompt[]) =>
  prompts.toSorted((a, b) => a.id.localeCompare(b.id));

describe("Lab prompt migration", () => {
  it("creates, updates, rejects name collisions, and round-trips exact text", async () => {
    const database = createTestLabD1Database();
    try {
      const before = (await listLabPrompts(database.d1)).length;
      const first = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Experiment", content: " line 1\n\nline 3\n" }),
        }),
        { LAB_DB: database.d1 },
      );
      expect(first.status).toBe(201);
      const created: unknown = await first.json();
      if (
        typeof created !== "object" ||
        created === null ||
        !("id" in created) ||
        typeof created.id !== "string"
      )
        throw new Error("Missing created prompt ID");
      expect(created).toMatchObject({ fileName: "Experiment", content: " line 1\n\nline 3\n" });
      const collision = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "experiment", content: "different" }),
        }),
        { LAB_DB: database.d1 },
      );
      expect(collision.status).toBe(409);
      const updated = await labWorkerTestHarness.fetch(
        new Request(`https://lab.example/_api/prompts/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "\nreplacement\n" }),
        }),
        { LAB_DB: database.d1 },
      );
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ id: created.id, content: "\nreplacement\n" });
      expect(
        (await listLabPrompts(database.d1)).find((prompt) => prompt.id === created.id)?.content,
      ).toBe("\nreplacement\n");
      expect(await listLabPrompts(database.d1)).toHaveLength(before + 1);
    } finally {
      database.close();
    }
  });
  it("rejects malformed or extra D1 prompt fields", () => {
    expect(() => decodePromptRow({ id: "a", file_name: 3, content: "text" })).toThrow();
    expect(() => decodePromptRow({ id: "a", file_name: "a.md" })).toThrow();
    expect(() =>
      decodePromptRow({ id: "a", file_name: "a.md", content: "text", extra: true }),
    ).toThrow();
    const inheritedId = { file_name: "a.md", content: "text" };
    Object.setPrototypeOf(inheritedId, { id: "a" });
    expect(() => decodePromptRow(inheritedId)).toThrow();
  });
  it("fills an empty library from the content folder's prompts", async () => {
    const database = createTestLabD1Database();
    try {
      await database.d1.prepare("DELETE FROM lab_prompts").run();
      const response = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts"),
        { LAB_DB: database.d1 },
      );
      expect(response.status).toBe(200);
      const library = await listLabPrompts(database.d1);
      expect(byId(library)).toEqual(byId(promptLibrarySeed));
      await expect(response.json()).resolves.toEqual(library);
    } finally {
      database.close();
    }
  });

  it("keeps a library that holds a prompt as it is", async () => {
    const database = createTestLabD1Database();
    try {
      await database.d1.prepare("DELETE FROM lab_prompts").run();
      const saved = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Experiment", content: "Sample prompt" }),
        }),
        { LAB_DB: database.d1 },
      );
      expect(saved.status).toBe(201);
      const response = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts"),
        { LAB_DB: database.d1 },
      );
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({ fileName: "Experiment", content: "Sample prompt" }),
      ]);
      expect(await listLabPrompts(database.d1)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("returns a bounded error when the database read fails", async () => {
    const response = await labWorkerTestHarness.fetch(
      new Request("https://lab.example/_api/prompts"),
      {
        LAB_DB: {
          prepare() {
            throw new Error("database failure");
          },
        },
      },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "lab_prompts_unavailable" });
  });

  it("serves exact migrated text from the Lab Worker", async () => {
    const database = createTestLabD1Database();
    try {
      const response = await labWorkerTestHarness.fetch(
        new Request("https://lab.example/_api/prompts"),
        { LAB_DB: database.d1 },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(await listLabPrompts(database.d1));
    } finally {
      database.close();
    }
  });
});
