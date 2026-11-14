import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

const runId = z.string().trim().min(1);
const timestamp = z.number().int().safe().nonnegative();
const ownedJson = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => z.json().parse(JSON.parse(JSON.stringify(value))), schema);

export const applicationStartupStatuses = ["pending", "succeeded", "failed"] as const;
export type ApplicationStartupStatus = (typeof applicationStartupStatuses)[number];

export const decodeRuntimeReadinessCallback = boundary({
  schema: ownedJson(z.strictObject({ runId, liveAt: timestamp })),
  convert: (value) => value,
});

export const decodeApplicationStartupDisposition = boundary({
  schema: ownedJson(
    z.strictObject({
      runId,
      disposition: z.enum(applicationStartupStatuses),
      decidedAt: timestamp.nullable(),
      reason: z.string().trim().min(1).nullable(),
      stopRequired: z.boolean(),
    }),
  ),
  convert: (value) => value,
});

export const decodeRuntimeRequiredStopRequest = boundary({
  schema: ownedJson(
    z.strictObject({
      runId,
      reason: z.literal("application_startup_failed"),
    }),
  ),
  convert: (value) => value,
});

/**
 * Runtime accepts every required stop. `acceptance` says whether Runtime ever accepted the Run:
 * `not_accepted` means Runtime fenced a Run it never accepted, so no Runtime result will follow.
 */
export const decodeRuntimeRequiredStopAcknowledgement = boundary({
  schema: ownedJson(
    z.strictObject({
      runId,
      accepted: z.literal(true),
      acceptance: z.enum(["accepted", "not_accepted"]),
    }),
  ),
  convert: (value) => value,
});

export type ApplicationStartupDisposition = ReturnType<typeof decodeApplicationStartupDisposition>;
