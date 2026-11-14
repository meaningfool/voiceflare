import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

const identity = z.string().trim().min(1);
export const connectionPayloadSchema = z.json();
export type ConnectionPayload = z.output<typeof connectionPayloadSchema>;
export const runtimeConnectionExchangeSchema = z.strictObject({
  exchangeId: identity,
  input: connectionPayloadSchema.optional(),
});
const validationRequestSchema = z.strictObject({
  profile: identity,
  connection: runtimeConnectionExchangeSchema,
});
const validationResponseSchema = z.strictObject({ profile: identity, fingerprint: identity });
const resultSchema = z.strictObject({
  runId: identity,
  exchangeId: identity,
  acceptance: z.enum(["accepted", "not_accepted", "unresolved"]),
  reply: connectionPayloadSchema.optional(),
  diagnostics: connectionPayloadSchema.optional(),
  error: z.string().min(1).optional(),
});
// Serialization excludes inherited fields before concrete owned-envelope validation.
const serialized = z.preprocess((value) => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}, z.unknown());
export const decodeRuntimeConnectionExchange = boundary({
  schema: serialized.pipe(runtimeConnectionExchangeSchema),
  convert: (value) => value,
});
export const decodeRuntimeConnectionValidationRequest = boundary({
  schema: serialized.pipe(validationRequestSchema),
  convert: (value) => value,
});
export const decodeRuntimeConnectionValidationResponse = boundary({
  schema: serialized.pipe(validationResponseSchema),
  convert: (value) => value,
});
export const decodeRuntimeConnectionResult = boundary({
  schema: serialized.pipe(resultSchema),
  convert: (value) => value,
});
export type RuntimeConnectionExchange = z.output<typeof runtimeConnectionExchangeSchema>;
/** The Realtime browser connection profile: an SDP offer and its answer. */
export const realtimeConnectionProfile = "realtime-v1";
/**
 * A connection profile's setup. A registry entry declares one for each profile it accepts;
 * the setup alone decodes and fingerprints that profile's native connection input.
 */
export type ConnectionSetup = Readonly<{
  profile: string;
  /** Decodes the native input and returns its fingerprint. */
  validate(input: ConnectionPayload | undefined): Promise<Readonly<{ fingerprint: string }>>;
}>;
export type RuntimeConnectionValidationRequest = z.output<typeof validationRequestSchema>;
export type RuntimeConnectionValidationResponse = z.output<typeof validationResponseSchema>;
export type RuntimeConnectionResult = z.output<typeof resultSchema>;
