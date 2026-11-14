import { runtimeWorkerTestHarness } from "../../runtime.ts";
import { conversationInputCheckPath } from "../../shared/contracts/conversationSelection.ts";

/**
 * A Runtime Worker service binding for an application's tests: Runtime's own catalog answers its
 * check of a selection's interview input, as a Runtime with these credentials, by default every
 * one its providers need, and every other request reaches the test's fake.
 */
export function runtimeBindingWithCatalogCheck(
  fetch: (request: Request) => Response | Promise<Response>,
  credentials: Readonly<{
    OPENAI_API_KEY?: string;
    SONIOX_API_KEY?: string;
    CEREBRAS_API_KEY?: string;
  }> = {
    OPENAI_API_KEY: "sk-test",
    SONIOX_API_KEY: "soniox-test",
    CEREBRAS_API_KEY: "cerebras-test",
  },
) {
  return {
    fetch: async (request: Request): Promise<Response> =>
      new URL(request.url).pathname === conversationInputCheckPath
        ? runtimeWorkerTestHarness.fetch(request, credentials)
        : fetch(request),
  };
}
