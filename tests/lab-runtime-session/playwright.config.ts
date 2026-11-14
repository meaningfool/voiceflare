import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const origin = process.env.TEST_LAB_ORIGIN;
if (!origin) throw new Error("Run pnpm test:lab-runtime-session so the runner owns Lab.");

export default defineConfig({
  testDir: ".",
  testMatch: /lab-runtime-session\.pw\.ts/,
  outputDir: fileURLToPath(new URL("../../test-results/lab-runtime-session", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: origin,
    ignoreHTTPSErrors: process.env.TEST_UNTRUSTED_TLS === "1",
    trace: "retain-on-failure",
  },
});
