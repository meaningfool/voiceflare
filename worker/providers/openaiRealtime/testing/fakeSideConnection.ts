import type { ProviderSocketEvent, ProviderWebSocket } from "../openaiRealtimeDriver.ts";

/**
 * A fake of the OpenAI Realtime side connection (the call's WebSocket) on workerd's
 * `WebSocketPair`, for tests that run Runtime on the platform. It stands in for the provider's
 * end only; Runtime's end is a real platform socket.
 */
export type FakeRealtimeSideConnection = Readonly<{
  /** Runtime's end, accepted, as `connectSideband` returns it. */
  connection: ProviderWebSocket;
  /**
   * The provider's end, not yet accepted: accept it to act as the provider inside the Worker,
   * or return it in a `101` response so that the test process acts as the provider.
   */
  provider: WebSocket;
  /** Each command Runtime sent on the connection, as parsed JSON, in order. */
  commands: readonly unknown[];
  /** Abrupt process loss: Runtime's listeners receive nothing from the provider any more. */
  sever(): void;
}>;

export function createFakeRealtimeSideConnection(): FakeRealtimeSideConnection {
  const pair = new WebSocketPair();
  const provider = pair[0];
  const native = pair[1];
  native.accept();
  const commands: unknown[] = [];
  let severed = false;
  const guarded = new Map<
    (event: ProviderSocketEvent) => void,
    (event: MessageEvent | CloseEvent | ErrorEvent) => void
  >();
  const connection: ProviderWebSocket = {
    get readyState() {
      return native.readyState;
    },
    accept() {
      native.accept();
    },
    close(code, reason) {
      native.close(code, reason);
    },
    send(data) {
      commands.push(JSON.parse(data));
      native.send(data);
    },
    addEventListener(type, listener) {
      const deliver = (event: MessageEvent | CloseEvent | ErrorEvent) => {
        // An error event carries neither data nor a close code.
        if (!severed) listener("data" in event || "code" in event ? event : {});
      };
      guarded.set(listener, deliver);
      native.addEventListener(type, deliver);
    },
    removeEventListener(type, listener) {
      const deliver = guarded.get(listener);
      if (deliver !== undefined) native.removeEventListener(type, deliver);
    },
  };
  return {
    connection,
    provider,
    commands,
    sever() {
      severed = true;
    },
  };
}

/**
 * The same fake reached as the provider serves it, over a WebSocket upgrade: `response` is the
 * `101` that carries the caller's end, and `provider` is the provider's end, accepted.
 */
export function serveFakeRealtimeSideConnection() {
  const pair = new WebSocketPair();
  const provider = pair[1];
  provider.accept();
  return { response: new Response(null, { status: 101, webSocket: pair[0] }), provider };
}
