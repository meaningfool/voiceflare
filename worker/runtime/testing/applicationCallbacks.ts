import type { ApplicationCallbacks } from "../applicationCallbacks.ts";
import type { RuntimeEnvironmentCapabilities, RuntimeFetchBinding } from "../types.ts";

/**
 * A Runtime environment that may also bind the test application, as `TEST_CALLBACK_WORKER`.
 * Runtime delivers a Start whose delivery target names `test` to it, as it delivers to any
 * application its configuration binds.
 */
export type TestApplicationEnvironment = RuntimeEnvironmentCapabilities &
  Readonly<{ TEST_CALLBACK_WORKER?: ApplicationCallbacks }>;

/**
 * A test application that holds every Run and sends its readiness, Transcripts and results to
 * `binding`. Runtime's host addresses each request to the callback it calls, such as
 * `/completion`. Like Lab, it keeps no startup timings.
 */
export function applicationCallbacks(binding: RuntimeFetchBinding): ApplicationCallbacks {
  const deliver = (request: Request) => Promise.resolve(binding.fetch(request));
  return {
    authorizeDelivery: async (request) =>
      Response.json({ runId: new URL(request.url).searchParams.get("runId"), authorized: true }),
    readiness: deliver,
    transcript: deliver,
    completion: deliver,
    startupDiagnostic: async () => new Response(null, { status: 204 }),
  };
}
