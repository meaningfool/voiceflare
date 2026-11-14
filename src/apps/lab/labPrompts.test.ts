import { describe, expect, it, vi } from "vitest";

import { hashInterviewPromptContent } from "./data/interviewPrompt";
import { createLabPromptStore } from "./labPrompts";

describe("Interview Lab prompts", () => {
  it("decodes saved prompts and rejects malformed write responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "new", fileName: "new.md", content: "\nexact\n" }),
      );
    const store = createLabPromptStore("https://lab.example", fetchImpl);
    expect((await store.createLabPrompt("new", "\nexact\n")).content).toBe("\nexact\n");
    expect(fetchImpl).toHaveBeenCalledWith("https://lab.example/_api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new", content: "\nexact\n" }),
    });
    for (const invalid of [
      { id: "new", fileName: 4, content: "text" },
      { id: "new", fileName: "new.md" },
      { id: "new", fileName: "new.md", content: "text", extra: true },
      Object.assign(Object.create({ id: "new" }), { fileName: "new.md", content: "text" }),
    ]) {
      fetchImpl.mockResolvedValueOnce(Response.json(invalid));
      await expect(store.updateLabPrompt("new", "text")).rejects.toThrow();
    }
  });
  it("round-trips exact Worker content and validates its consumer contract", async () => {
    const content = " First line\n\nLast line\n";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([{ id: "saved", fileName: "saved.md", content }]));
    const prompts = await createLabPromptStore("https://lab.example", fetchImpl).listLabPrompts();
    expect(prompts[0]?.content).toBe(content);
    expect(prompts[0]?.provenance.contentHash).toBe(hashInterviewPromptContent(content));
    expect(fetchImpl).toHaveBeenCalledWith("https://lab.example/_api/prompts", { method: "GET" });
    for (const invalid of [
      [{ id: "saved", fileName: 42, content }],
      [{ id: "saved", content }],
      [{ id: "saved", fileName: "saved.md", content, extra: true }],
    ]) {
      fetchImpl.mockResolvedValueOnce(Response.json(invalid));
      await expect(
        createLabPromptStore("https://lab.example", fetchImpl).listLabPrompts(),
      ).rejects.toThrow();
    }
  });

  it("surfaces Worker read errors instead of falling back to bundled prompts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "lab_prompts_unavailable" }, { status: 500 }));
    await expect(
      createLabPromptStore("https://lab.example", fetchImpl).listLabPrompts(),
    ).rejects.toThrow("lab_prompts_unavailable");
  });
});
