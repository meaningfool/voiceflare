import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  realtimeConnectionProfile,
  type ConnectionPayload,
  type ConnectionSetup,
} from "../../shared/contracts/runtimeConnection.ts";

const decodeRealtimeOffer = boundary({
  schema: z.preprocess(
    (value) => {
      const parsed: unknown = JSON.parse(JSON.stringify(value));
      return parsed;
    },
    z.strictObject({
      sdp: z.string().refine((value) => value.includes("v=0"), { message: "invalid_sdp_offer" }),
    }),
  ),
  convert: (value) => value,
});

export function decodeConversationOffer(input: ConnectionPayload | undefined): { sdp: string } {
  try {
    return decodeRealtimeOffer(input);
  } catch {
    throw new Error("invalid_sdp_offer");
  }
}

/** Realtime's browser connection: an SDP offer, which the OpenAI call answers. */
export const realtimeConnectionSetup: ConnectionSetup = Object.freeze({
  profile: realtimeConnectionProfile,
  async validate(input: ConnectionPayload | undefined) {
    const native = decodeConversationOffer(input);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(native.sdp));
    return {
      fingerprint: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  },
});
