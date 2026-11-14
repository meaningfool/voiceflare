import { fileURLToPath } from "node:url";
import { build } from "vite";
import { withSubstituteContent } from "./labContent.ts";

const [outDir] = process.argv.slice(2);
if (outDir === undefined) throw new Error("Expected the Lab page's output directory");

// Lab's own build, with the substitute content folder in place of Lab's.
await build({
  configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
  mode: "lab",
  build: { outDir, emptyOutDir: true },
  plugins: [
    {
      name: "lab-runtime-session-content",
      enforce: "pre",
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        return resolved === null ? null : { ...resolved, id: withSubstituteContent(resolved.id) };
      },
    },
  ],
});
