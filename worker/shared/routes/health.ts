import { jsonResponse } from "../http.ts";

type HealthFacts = Readonly<Record<string, unknown>>;

export function handleHealth<Environment extends object>(
  request: Request,
  env: Environment,
  service: string,
  facts: HealthFacts = {},
  exposedHeaders: readonly string[] = [],
): Response {
  return jsonResponse(
    request,
    env,
    {
      ok: true,
      service,
      ...facts,
    },
    200,
    exposedHeaders,
  );
}
