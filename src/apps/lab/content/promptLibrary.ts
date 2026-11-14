import everydayTool from "./prompts/everyday-tool.md";

/**
 * The prompts the Lab Worker puts in Lab's prompt library when the library holds none. A library
 * that already holds prompts keeps them. This folder is voiceflare's own content: a refresh of the
 * copied code keeps it.
 */
export const promptLibrarySeed = [
  { id: "everyday-tool", fileName: "everyday-tool.md", content: everydayTool },
];
