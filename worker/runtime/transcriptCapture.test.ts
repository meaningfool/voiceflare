import { describe, expect, it } from "vitest";

import { restoreTranscriptCapture, serializeTranscriptCapture } from "./transcriptCapture.ts";

describe("sideband Transcript persistence ingress", () => {
  it("defaults malformed captures and preserves valid fields without inventing optional ones", () => {
    expect(serializeTranscriptCapture(restoreTranscriptCapture("malformed"))).toEqual({
      sequence: 0,
      items: [],
    });

    expect(
      serializeTranscriptCapture(
        restoreTranscriptCapture({
          sequence: 4,
          items: [
            { itemId: "item_1", firstSeenSequence: 2, ignored: true },
            { itemId: 42, text: "ignored malformed item" },
          ],
        }),
      ),
    ).toEqual({
      sequence: 4,
      items: [{ itemId: "item_1", firstSeenSequence: 2 }],
    });
  });
});
