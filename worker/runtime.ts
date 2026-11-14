import {
  conversationCatalog,
  createRuntimeHostAssembly,
  validateRegisteredConnection,
} from "./runtimeHostComposition.ts";
import { localRuntimeConfiguration } from "./runtimeLocalConfiguration.ts";
import {
  conversationInputCheckPath,
  conversationInputRefusals,
  decodeConversationInputCheck,
  isMissingCredentialsRefusal,
  missingCredentialsRefusal,
} from "./shared/contracts/conversationSelection.ts";
import { decodeRuntimeConnectionValidationRequest } from "./shared/contracts/runtimeConnection.ts";
import type { ConversationConnectionImplementation } from "./runtime/conversationConnection.ts";
import { prepareExecutionSettings } from "./runtime/interviewStartupCoordinator.ts";
import { corsHeaders, jsonResponse } from "./shared/http.ts";
import { handleHealth } from "./shared/routes/health.ts";
import { handleRuntimeControllerRoute } from "./runtime/routes/runtimeController.ts";
import { readRuntimeCredentials, type RuntimeEnvironmentCapabilities } from "./runtime/types.ts";
import type { PreparedExecutionSettings } from "./runtime/nativeContracts.ts";

/**
 * Runtime's Durable Object class, one instance per Run. It is deployed as `RunController`: the
 * migration that introduced that name deleted the class's earlier storage (#983).
 */
export { InterviewRuntimeController as RunController } from "./runtimeHostController.ts";

const runtimeServiceName = "runtime";
/** The registry under this Runtime's configuration, as its controllers assemble it. */
const assembly = createRuntimeHostAssembly(localRuntimeConfiguration);
const credentialsOf = (env: RuntimeEnvironmentCapabilities) =>
  readRuntimeCredentials(env, assembly.credentialNames);

export const runtimeWorkerTestHarness = {
  async fetch(
    request: Request,
    env: RuntimeEnvironmentCapabilities,
    _ctx?: ExecutionContext,
    connectionImplementation?: ConversationConnectionImplementation,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method === "GET" && url.pathname === "/_runtime/conversation-selections")
      return jsonResponse(
        request,
        env,
        conversationCatalog(credentialsOf(env), localRuntimeConfiguration),
      );

    // The catalog's check of a selection's input, as Runtime applies it at start; no Run starts.
    if (request.method === "POST" && url.pathname === conversationInputCheckPath) {
      let check;
      try {
        check = decodeConversationInputCheck(await request.json());
      } catch {
        return jsonResponse(request, env, { error: "invalid_conversation_input_check" }, 400);
      }
      let prepared: PreparedExecutionSettings | undefined;
      try {
        assembly.validateInput(check.selection, check.agentInput);
        // The selected execution refuses settings it cannot prepare, as it does at start.
        if (check.executionSettings !== undefined)
          prepared = prepareExecutionSettings(assembly.resolve(check.selection), {
            reasoningEffort: null,
            requested: check.executionSettings,
          });
      } catch (error) {
        const refusal = conversationInputRefusals.find(
          (code) => error instanceof Error && error.message === code,
        );
        if (refusal === undefined) throw error;
        return jsonResponse(request, env, { error: refusal }, 400);
      }
      // The selected combination refuses to start without the credentials of the providers its
      // settings choose.
      const missing = assembly.missingCredentials(check.selection, credentialsOf(env), prepared);
      if (missing.length > 0)
        return jsonResponse(request, env, { error: missingCredentialsRefusal(missing) }, 400);
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      // Whether each combination can start is the catalog's `availability`, per provider.
      return handleHealth(request, env, runtimeServiceName);
    }

    if (request.method === "POST" && url.pathname === "/_runtime/connections/validate") {
      if (connectionImplementation?.available === false)
        return jsonResponse(request, env, { error: "connection_profile_unavailable" }, 503);
      try {
        const input = decodeRuntimeConnectionValidationRequest(await request.json());
        if (connectionImplementation !== undefined) {
          if (input.profile !== connectionImplementation.profile)
            throw new Error("connection_profile_unavailable");
          return jsonResponse(request, env, {
            profile: input.profile,
            ...(await connectionImplementation.validate(input.connection.input)),
          });
        }
        return jsonResponse(
          request,
          env,
          await validateRegisteredConnection(
            input.profile,
            input.connection,
            credentialsOf(env),
            localRuntimeConfiguration,
          ),
        );
      } catch (error) {
        // An execution that cannot start makes this Runtime unable to serve the connection.
        if (error instanceof Error && isMissingCredentialsRefusal(error.message))
          return jsonResponse(request, env, { error: error.message }, 503);
        return jsonResponse(
          request,
          env,
          { error: error instanceof Error ? error.message : "invalid_connection_request" },
          400,
        );
      }
    }
    const controllerResponse = await handleRuntimeControllerRoute(request, env);

    if (controllerResponse !== null) {
      return controllerResponse;
    }

    return jsonResponse(request, env, { error: "not_found" }, 404);
  },
} satisfies ExportedHandler<RuntimeEnvironmentCapabilities>;

export default {
  fetch(request: Request, env: RuntimeEnv, _ctx: ExecutionContext): Promise<Response> {
    return runtimeWorkerTestHarness.fetch(request, env);
  },
} satisfies ExportedHandler<RuntimeEnv>;
