import type { BuildOptions } from "esbuild";

/**
 * How platform tests bundle a Worker for workerd: one ES module with the Workers resolution
 * conditions, Liquid templates and Markdown as text and the platform's own modules left to workerd. Each
 * test adds its entry point or its `stdin` source.
 */
export const platformBuildOptions = {
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:workers", "node:*"],
  alias: { liquidjs: "liquidjs/dist/liquid.browser.mjs" },
  loader: { ".liquid": "text", ".md": "text" },
} satisfies BuildOptions;
