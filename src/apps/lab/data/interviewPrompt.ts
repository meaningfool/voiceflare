export type InterviewPromptProvenance = {
  promptId: string;
  contentHash: string;
};

const fnv1a64Offset = 0xcbf29ce484222325n;
const fnv1a64Prime = 0x100000001b3n;
const uint64Mask = 0xffffffffffffffffn;

export function createInterviewPromptProvenance({
  promptId,
  content,
}: {
  promptId: string;
  content: string;
}): InterviewPromptProvenance {
  return {
    promptId,
    contentHash: hashInterviewPromptContent(content),
  };
}

export function hashInterviewPromptContent(content: string): string {
  let hash = fnv1a64Offset;

  for (const byte of new TextEncoder().encode(content.trim())) {
    hash ^= BigInt(byte);
    hash = (hash * fnv1a64Prime) & uint64Mask;
  }

  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
