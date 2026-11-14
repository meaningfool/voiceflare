import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  cascadeMediaConnectionInputSchema,
  cascadeMediaConnectionProfile,
} from "../../shared/contracts/cascadeMedia.ts";
import type {
  ConnectionPayload,
  ConnectionSetup,
} from "../../shared/contracts/runtimeConnection.ts";

const decodeCascadeMediaInput = boundary({
  schema: cascadeMediaConnectionInputSchema,
  convert: (value) => value,
});

function check(input: ConnectionPayload | undefined): void {
  try {
    decodeCascadeMediaInput(input);
  } catch {
    throw new Error("invalid_cascade_media_connection");
  }
}

/**
 * Cascade's browser connection: Start carries no native negotiation, and the browser then
 * attaches its media through Lab's private attachment route.
 */
export const cascadeMediaConnectionSetup: ConnectionSetup = Object.freeze({
  profile: cascadeMediaConnectionProfile,
  validate(input: ConnectionPayload | undefined) {
    check(input);
    return Promise.resolve({ fingerprint: cascadeMediaConnectionProfile });
  },
});
