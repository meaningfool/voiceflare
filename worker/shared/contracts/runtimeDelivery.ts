import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

/** Only the host interprets application context; Runtime persists the serializable selection. */
export const runtimeDeliveryTargetSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (value === null || typeof value !== "object") return;
    for (const key of ["integration", "context"])
      if (key in value && !Object.hasOwn(value, key))
        context.addIssue({ code: "custom", path: [key], message: "must be an own property" });
  })
  .pipe(
    z.strictObject({
      integration: z.string().min(1),
      context: z.json(),
    }),
  );
export type RuntimeDeliveryTarget = z.output<typeof runtimeDeliveryTargetSchema>;
export const decodeRuntimeDeliveryTarget = boundary({
  schema: runtimeDeliveryTargetSchema,
  convert: (value) => value,
});
const retainedTarget = boundary({ schema: runtimeDeliveryTargetSchema, convert: (value) => value });
export function decodeRetainedDeliveryTarget(json: string): RuntimeDeliveryTarget;
export function decodeRetainedDeliveryTarget(json: string | null): RuntimeDeliveryTarget | null;
export function decodeRetainedDeliveryTarget(json: string | null): RuntimeDeliveryTarget | null {
  return json === null ? null : retainedTarget(JSON.parse(json));
}
