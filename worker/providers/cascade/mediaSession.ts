import { type Cause, Context, Data, Effect, Queue, type Scope, Stream } from "effect";
import {
  decodeCascadeMediaClientMessage,
  type CascadeMediaServerMessage,
} from "../../shared/contracts/cascadeMedia.ts";

/** The server end of a browser's media attachment, as the media session uses it. */
export type MediaSocket = Readonly<{
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: Readonly<{ data: string | ArrayBuffer }>) => void,
  ): void;
}>;

/** The attachment closed or refused a write before the output was delivered. */
export class MediaDeliveryFailed extends Data.TaggedError("MediaDeliveryFailed")<{
  code: string;
}> {}

/** One identified interviewer output being delivered to the attached browser. */
export type MediaOutput = Readonly<{
  /** Delivers the next audio chunk, numbered in order. */
  write(audio: Uint8Array): Effect.Effect<void, MediaDeliveryFailed>;
  /** Delivers the output's explicit end once its last chunk was written. */
  end: Effect.Effect<void, MediaDeliveryFailed>;
  /** Delivers the output's failure; the browser stops it. */
  fail(code: string): Effect.Effect<void>;
}>;

/** One open listening opportunity: the participant audio the browser sent for it. */
export type MediaInput = Readonly<{
  opportunityId: string;
  /**
   * The opportunity's audio chunks, in the profile's input format, in arrival order. It ends
   * when the opportunity or the attachment closes.
   */
  audio: Stream.Stream<Uint8Array>;
  /** Chunks accepted for this opportunity, and chunks the session discarded so far. */
  counts(): Readonly<{ accepted: number; discarded: number }>;
  /**
   * Closes the opportunity before its Scope does: the browser is told, audio already accepted
   * still streams, and later audio for it is discarded. Closing again does nothing.
   */
  close: Effect.Effect<void>;
}>;

/**
 * The Run's media session as a Cascade flow sees it. Opening an output announces it; closing
 * the Scope that opened it before its end or failure cancels it, and the browser clears it.
 * Listening opens one identified opportunity; closing its Scope closes it, and audio that
 * names no open opportunity is discarded.
 */
export class CascadeMedia extends Context.Service<
  CascadeMedia,
  Readonly<{
    open(outputId: string): Effect.Effect<MediaOutput, MediaDeliveryFailed, Scope.Scope>;
    /**
     * Tells the browser to stop an output whose end was already delivered, which it may still be
     * playing: it clears it as it clears a cancelled output. An output it finished playing has
     * nothing left to stop.
     */
    stop(outputId: string): Effect.Effect<void>;
    /** Opens a listening opportunity the browser takes once `afterOutputId` played locally. */
    listen(
      afterOutputId: string | null,
    ): Effect.Effect<MediaInput, MediaDeliveryFailed, Scope.Scope>;
  }>
>()("providers/cascade/CascadeMedia") {}

type Listening = {
  readonly opportunityId: string;
  readonly queue: Queue.Queue<Uint8Array, Cause.Done>;
  accepted: number;
};

/**
 * One Run's media session. It accepts the Run's single browser attachment, delivers its
 * identified outputs over it and receives participant audio for the open listening
 * opportunity only; there is no reconnection. It belongs to the Run's Cascade execution
 * session, under Runtime's lifecycle.
 */
export class CascadeMediaSession {
  #socket: MediaSocket | null = null;
  #attached = false;
  #closed = false;
  #listening: Listening | null = null;
  #discarded = 0;

  /** Whether a browser attached; a Run accepts one attachment, even after it closed. */
  get attached(): boolean {
    return this.#attached;
  }

  /** Whether the attachment is currently open for delivery. */
  get open(): boolean {
    return this.#socket !== null && !this.#closed;
  }

  /** Takes the Run's one attachment. A second attachment is refused. */
  attach(socket: MediaSocket, detached: () => void): boolean {
    if (this.#attached) return false;
    this.#attached = true;
    this.#socket = socket;
    const close = () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#socket = null;
      this.#closeListening();
      detached();
    };
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
    socket.addEventListener("message", (event) => this.#receive(event.data));
    return true;
  }

  /** Ends the attachment; no further output can be delivered or input received. */
  close(reason: string): void {
    const socket = this.#socket;
    this.#closed = true;
    this.#socket = null;
    this.#closeListening();
    if (socket === null) return;
    try {
      socket.close(1000, reason);
    } catch {
      /* Releasing an already-closed attachment is not delivery evidence. */
    }
  }

  /** Participant audio counts only for the open opportunity it names; all else is discarded. */
  #receive(data: string | ArrayBuffer): void {
    const listening = this.#listening;
    let message;
    try {
      message = decodeCascadeMediaClientMessage(data);
    } catch {
      this.#discarded += 1;
      return;
    }
    if (this.#closed || listening === null || message.opportunityId !== listening.opportunityId) {
      this.#discarded += 1;
      return;
    }
    listening.accepted += 1;
    Queue.offerUnsafe(listening.queue, decodeBase64(message.audio));
  }

  /**
   * The attachment closed: the opportunity's audio simply ends. The browser closes it when
   * participation ends, which is not a media failure.
   */
  #closeListening(): void {
    const listening = this.#listening;
    if (listening === null) return;
    this.#listening = null;
    Queue.endUnsafe(listening.queue);
  }

  #deliver(message: CascadeMediaServerMessage) {
    return Effect.suspend(() => {
      const socket = this.#socket;
      if (socket === null || this.#closed)
        return Effect.fail(new MediaDeliveryFailed({ code: "media_attachment_closed" }));
      try {
        socket.send(JSON.stringify(message));
        return Effect.void;
      } catch {
        return Effect.fail(new MediaDeliveryFailed({ code: "media_delivery_failed" }));
      }
    });
  }

  readonly media: CascadeMedia["Service"] = CascadeMedia.of({
    open: (outputId) => {
      let sequence = 0;
      let settled = false;
      const deliver = (message: CascadeMediaServerMessage) => this.#deliver(message);
      const output: MediaOutput = {
        write: (audio) =>
          Effect.suspend(() =>
            settled
              ? Effect.fail(new MediaDeliveryFailed({ code: "media_output_settled" }))
              : deliver({
                  type: "output.audio",
                  outputId,
                  sequence: sequence++,
                  audio: encodeBase64(audio),
                }),
          ),
        end: Effect.suspend(() => {
          if (settled)
            return Effect.fail(new MediaDeliveryFailed({ code: "media_output_settled" }));
          settled = true;
          return deliver({ type: "output.ended", outputId, chunkCount: sequence });
        }),
        fail: (code) =>
          Effect.suspend(() => {
            if (settled) return Effect.void;
            settled = true;
            return Effect.ignore(deliver({ type: "output.failed", outputId, code }));
          }),
      };
      return Effect.acquireRelease(
        Effect.as(deliver({ type: "output.started", outputId }), output),
        () =>
          Effect.suspend(() => {
            if (settled) return Effect.void;
            settled = true;
            return Effect.ignore(deliver({ type: "output.cancelled", outputId }));
          }),
      );
    },
    stop: (outputId) => Effect.ignore(this.#deliver({ type: "output.cancelled", outputId })),
    listen: (afterOutputId) => {
      const self = this;
      return Effect.acquireRelease(
        Effect.gen(function* () {
          const listening: Listening = {
            opportunityId: `cascade_listening_${crypto.randomUUID()}`,
            queue: yield* Queue.unbounded<Uint8Array, Cause.Done>(),
            accepted: 0,
          };
          yield* self.#deliver({
            type: "input.listening",
            opportunityId: listening.opportunityId,
            afterOutputId,
          });
          // One opportunity at a time: a new one replaces any other.
          self.#closeListening();
          self.#listening = listening;
          let closed = false;
          const input: MediaInput = {
            opportunityId: listening.opportunityId,
            audio: Stream.fromQueue(listening.queue),
            counts: () => ({ accepted: listening.accepted, discarded: self.#discarded }),
            close: Effect.suspend(() => {
              if (closed) return Effect.void;
              closed = true;
              if (self.#listening === listening) {
                self.#listening = null;
                Queue.endUnsafe(listening.queue);
              }
              return Effect.ignore(
                self.#deliver({ type: "input.closed", opportunityId: listening.opportunityId }),
              );
            }),
          };
          return input;
        }),
        (input) => input.close,
      );
    },
  });
}

/**
 * Accepts a browser's WebSocket upgrade as a media attachment, or returns null for a request
 * that is not one.
 */
export function acceptMediaAttachment(
  request: Request,
): Readonly<{ response: Response; socket: MediaSocket }> | null {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return null;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  return { response: new Response(null, { status: 101, webSocket: client }), socket: server };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
