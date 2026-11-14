/**
 * The private callbacks every application Runtime delivers to implements, on the service binding
 * the Runtime Worker's configuration declares for it. Runtime calls each method directly; a
 * request's URL names no destination and carries no authority.
 */
export type ApplicationCallbacks = Readonly<{
  /** Confirms before setup acceptance that the application holds the Run its `runId` names. */
  authorizeDelivery(request: Request): Promise<Response>;
  readiness(request: Request): Promise<Response>;
  transcript(request: Request): Promise<Response>;
  /** Every terminal result, a failed start included. */
  completion(request: Request): Promise<Response>;
  /** Runtime's startup timings, best effort. An application may keep nothing. */
  startupDiagnostic(request: Request): Promise<Response>;
}>;

/** A callback that carries one of a Run's messages to its application. */
export type ApplicationCallback = Exclude<keyof ApplicationCallbacks, "authorizeDelivery">;

/** A callback request's address. It names the callback and carries nothing else. */
export function applicationCallbackUrl(callback: ApplicationCallback): string {
  return `https://application-delivery.internal/${callback}`;
}

/**
 * One bounded callback. Request.signal bounds local HTTP work; named RPC has no remote abort
 * contract. A lost or timed-out acknowledgement can follow a committed receiver transaction.
 */
export async function deliverBoundedCallback(
  dispatch: (request: Request) => Promise<Response>,
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<Response> {
  signal.throwIfAborted();
  // Explicit AbortSignals cannot cross production RPC. Keep cancellation local.
  const callbackRequest = new Request(request, { signal: null });
  const call = dispatch(callbackRequest);
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeCallbackCall(call);
  };
  const onAbort = () => {
    rejectAbort(signal.reason);
    dispose();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    // Keep the local deadline active until the acknowledgement body is received.
    const buffered = Promise.resolve(call).then((response) =>
      bufferCallbackResponse(response, signal),
    );
    return await Promise.race([buffered, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    dispose();
  }
}

async function bufferCallbackResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return new Response(null, response);
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
    signal.throwIfAborted();
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(size === 0 ? null : body, response);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function disposeCallbackCall(call: Promise<Response>): void {
  // Workerd RPC thenables own their eventual result, including response streams.
  // Disposal releases those resources; it cannot undo a receiver's durable write.
  if (!(Symbol.dispose in call)) return;
  const dispose = call[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(call);
}
