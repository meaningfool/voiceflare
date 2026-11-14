import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import type { D1DatabaseCapability } from "../../shared/persistence/runDiagnosticsD1.ts";

const promptRowSchema = z
  .unknown()
  .refine(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      Object.hasOwn(row, "id") &&
      Object.hasOwn(row, "file_name") &&
      Object.hasOwn(row, "content"),
    { error: "Lab prompt row requires own fields" },
  )
  .pipe(
    z.strictObject({
      id: z.string(),
      file_name: z.string(),
      content: z.string(),
    }),
  );

export const decodePromptRow = boundary({
  schema: promptRowSchema,
  convert: (row) => ({ id: row.id, fileName: row.file_name, content: row.content }),
});

export type LabPrompt = ReturnType<typeof decodePromptRow>;

export async function listLabPrompts(db: D1DatabaseCapability): Promise<LabPrompt[]> {
  const rows = await db
    .prepare("SELECT id, file_name, content FROM lab_prompts ORDER BY file_name")
    .all();
  return rows.results.map(decodePromptRow);
}

/**
 * Puts `prompts` in Lab's prompt library when the library holds no prompt. One statement checks
 * and inserts, so a library that gains a prompt in between keeps only that prompt.
 */
export async function fillEmptyLabPromptLibrary(
  db: D1DatabaseCapability,
  prompts: readonly LabPrompt[],
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO lab_prompts (id, file_name, content) SELECT json_extract(value, '$.id'), json_extract(value, '$.fileName'), json_extract(value, '$.content') FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM lab_prompts)",
    )
    .bind(JSON.stringify(prompts))
    .run();
}

export async function createLabPrompt(
  db: D1DatabaseCapability,
  fileName: string,
  content: string,
): Promise<LabPrompt | null> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      "INSERT INTO lab_prompts (id, file_name, content) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM lab_prompts WHERE lower(file_name) = lower(?)) ON CONFLICT DO NOTHING",
    )
    .bind(id, fileName, content, fileName)
    .run();
  if (result.meta?.changes !== 1) return null;
  return { id, fileName, content };
}

export async function updateLabPrompt(
  db: D1DatabaseCapability,
  id: string,
  content: string,
): Promise<LabPrompt | null> {
  const result = await db
    .prepare("UPDATE lab_prompts SET content = ? WHERE id = ?")
    .bind(content, id)
    .run();
  if (result.meta?.changes !== 1) return null;
  const row = await db
    .prepare("SELECT id, file_name, content FROM lab_prompts WHERE id = ?")
    .bind(id)
    .first();
  return row === null ? null : decodePromptRow(row);
}
