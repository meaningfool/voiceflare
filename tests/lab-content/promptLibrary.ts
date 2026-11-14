import interview from "./prompts/interview.md";

/**
 * A substitute for Lab's prompt library seed (`src/apps/lab/content/promptLibrary.ts`): one prompt
 * the Lab Worker puts in an empty library.
 */
export const promptLibrarySeed = [
  { id: "interview", fileName: "interview.md", content: interview },
];
