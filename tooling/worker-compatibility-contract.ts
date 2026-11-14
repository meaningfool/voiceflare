import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

import { boundary } from "../tools/boundary-contracts/boundary-contracts.mjs";

const compatibilitySchema = z.json().pipe(
  z.object(
    {
      compatibility_date: z.string({
        error: (issue) =>
          issue.input === undefined
            ? "must define top-level compatibility_date."
            : "top-level compatibility_date must be a string.",
      }),
      compatibility_flags: z.array(z.string(), {
        error: (issue) =>
          issue.input === undefined
            ? "must define top-level compatibility_flags."
            : "top-level compatibility_flags must be an array of strings.",
      }),
    },
    { error: "must contain a JSONC object." },
  ),
);

export const decodeJsonc = boundary({
  schema: compatibilitySchema,
  convert: (value) => value,
});

export function parseWorkerCompatibility(contents: string, path: string) {
  const errors: ParseError[] = [];
  const raw: unknown = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `${path} must contain valid JSONC:\n${errors
        .map(({ error, offset }) => `- ${printParseErrorCode(error)} at offset ${offset}`)
        .join("\n")}`,
    );
  }

  try {
    return decodeJsonc(raw);
  } catch (error) {
    // The boundary deliberately hides schema errors. Recover diagnostics only on
    // failure; the successful path always consumes the boundary's owned output.
    const result = compatibilitySchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const message =
        issue?.path[0] === "compatibility_flags" && issue.path.length > 1
          ? "top-level compatibility_flags must be an array of strings."
          : issue?.message;
      throw new Error(`${path} ${message}`, { cause: error });
    }
    throw error;
  }
}
