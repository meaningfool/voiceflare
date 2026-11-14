import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

const runId = z.string().trim().min(1);
export const decodeRuntimeAcceptanceRequest = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z.strictObject({ runId }),
  ),
  convert: (value) => value,
});
export const decodeRuntimeAcceptanceResponse = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z.strictObject({ runId, acceptance: z.enum(["accepted", "not_accepted"]) }),
  ),
  convert: (value) => value,
});
export type RuntimeAcceptance = ReturnType<typeof decodeRuntimeAcceptanceResponse>["acceptance"];
