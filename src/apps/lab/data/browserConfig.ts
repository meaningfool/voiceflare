import { z } from "zod";
import { boundary } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";

export type BrowserConfig = {
  labWorkerUrl: string | null;
};

export const readBrowserEnvironment = boundary({
  schema: z.object({ VITE_LAB_WORKER_URL: z.string().optional() }),
  convert: (environment) => environment,
});

export function readBrowserConfig(): BrowserConfig {
  const environment = readBrowserEnvironment(import.meta.env);
  const labWorkerUrl = environment.VITE_LAB_WORKER_URL?.trim();

  return { labWorkerUrl: labWorkerUrl || null };
}
