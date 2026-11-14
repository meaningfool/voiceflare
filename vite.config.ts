import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// The Lab page, built for the Lab Worker to serve (`wrangler.lab.jsonc`), and the Vitest suite.
export default defineConfig(() => {
  const isVitest = process.env.VITEST === "true";
  const sourceAlias = fileURLToPath(new URL("./src", import.meta.url));
  const alias = isVitest
    ? {
        "@": sourceAlias,
        "cloudflare:workers": fileURLToPath(
          new URL("./worker/runtime/cloudflareWorkersTestShim.ts", import.meta.url),
        ),
      }
    : { "@": sourceAlias };

  return {
    resolve: { alias },
    plugins: [react(), tailwindcss(), labMarkdownPlugin()],
    build: { outDir: "dist/lab/client" },
    test: {
      include: ["{src,worker,scripts,tooling}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
      setupFiles: ["./src/test/domTestSetup.ts"],
    },
  };
});

/**
 * Lab's Markdown, such as its content folder's prompts, imports as its text, as the Lab Worker's
 * Text module rule makes it in `wrangler.lab.jsonc`.
 */
function labMarkdownPlugin(): Plugin {
  return {
    name: "lab-markdown",
    load(id) {
      return id.endsWith(".md")
        ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};`
        : null;
    },
  };
}
