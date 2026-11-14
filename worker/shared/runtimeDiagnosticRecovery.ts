import {
  decodeRuntimeDiagnosticPage,
  runtimeDiagnosticRetentionMs,
  type RuntimeDiagnosticRecord,
} from "./contracts/runtimeDiagnostics.ts";
import {
  getRuntimeDiagnosticRecoveryCursor,
  advanceRuntimeDiagnosticRecoveryCursor,
  type D1DatabaseCapability,
} from "./persistence/runDiagnosticsD1.ts";

type FetchBinding = Readonly<{ fetch(request: Request): Response | Promise<Response> }>;
/** A single optional read is bounded locally, including headers and streamed body.
 * The Request signal reaches HTTP service bindings; the local race also contains
 * adapters/platform versions that do not propagate remote cancellation.
 */
export async function recoverRuntimeDiagnostics(
  input: Readonly<{
    db: D1DatabaseCapability;
    runtime: FetchBinding | undefined;
    runId: string;
    persist(records: readonly RuntimeDiagnosticRecord[]): Promise<void>;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  if (input.runtime === undefined || input.signal?.aborted) return;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => controller.abort();
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        void reader?.cancel().catch(() => undefined);
        reject(new Error("runtime_diagnostic_recovery_cancelled"));
      },
      { once: true },
    );
  });
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 1500);
  const runtime = input.runtime;
  try {
    const recover = async () => {
      let cursor = await getRuntimeDiagnosticRecoveryCursor(input.db, input.runId);
      let bytes = 0;
      let count = 0;
      // At most ten pages / 1,000 records / 256 KiB over this entire read.
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        if (controller.signal.aborted) return;
        const response = await runtime.fetch(
          new Request(
            `https://runtime.internal/_runtime/controllers/${encodeURIComponent(input.runId)}/diagnostics?cursor=${cursor}`,
            {
              signal: controller.signal,
            },
          ),
        );
        if (controller.signal.aborted || !response.ok || response.body === null) {
          void response.body?.cancel().catch(() => undefined);
          return;
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let pageBytes = 0;
        for (;;) {
          const part = await reader.read();
          if (controller.signal.aborted) return;
          if (part.done) break;
          bytes += part.value.byteLength;
          pageBytes += part.value.byteLength;
          if (bytes > 262_144 || pageBytes > 65_536) {
            cancel();
            return;
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        reader.releaseLock();
        reader = undefined;
        const page = decodeRuntimeDiagnosticPage(JSON.parse(text));
        count += page.records.length;
        if (
          page.runId !== input.runId ||
          page.records.some((record) => record.runId !== input.runId) ||
          count > 1000 ||
          page.cursor < cursor ||
          (page.hasMore && page.cursor <= cursor)
        )
          throw new Error("invalid_runtime_diagnostic_page");
        if (controller.signal.aborted) return;
        await input.persist(
          page.records.filter(
            (record) => record.observedAt + runtimeDiagnosticRetentionMs > Date.now(),
          ),
        );
        // Writes and application projections must all succeed before acknowledging this page.
        if (controller.signal.aborted) return;
        await advanceRuntimeDiagnosticRecoveryCursor(input.db, input.runId, page.cursor);
        cursor = page.cursor;
        if (!page.hasMore) return;
      }
    };
    await Promise.race([recover(), stopped]);
  } catch {
    // Evidence stays unavailable/retryable; canonical results do not depend on it.
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
