import { z } from "zod";

/** A provider message's JSON text, validated by `schema` once parsed. */
export function jsonText<T extends z.ZodType>(schema: T) {
  return z.string().transform((text, context): z.output<T> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      context.addIssue({ code: "custom", message: "The provider message is not JSON" });
      return z.NEVER;
    }
    const accepted = schema.safeParse(parsed);
    if (accepted.success) return accepted.data;
    for (const issue of accepted.error.issues)
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return z.NEVER;
  });
}
