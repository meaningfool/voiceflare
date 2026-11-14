import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const labContent = fileURLToPath(new URL("../../src/apps/lab/content/", import.meta.url));
const substituteContent = fileURLToPath(new URL("../lab-content/", import.meta.url));

/**
 * Where this suite builds Lab's `path` from: a file of Lab's content folder comes from the same
 * place in the substitute content folder, `tests/lab-content/`; any other file is Lab's own.
 */
export function withSubstituteContent(path: string): string {
  return path.startsWith(labContent) ? join(substituteContent, relative(labContent, path)) : path;
}
