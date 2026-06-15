import { afterEach, describe, expect, it } from "vitest";
import { getLlmProvider, NullLlm, type LlmProvider } from "./llm.js";

const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

describe("getLlmProvider", () => {
  it("returns a NullLlm when no key is configured, and it rejects on use", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = getLlmProvider();
    expect(p).toBeInstanceOf(NullLlm);
    await expect(p.complete({ prompt: "hi" })).rejects.toThrow(/LLM unavailable/);
  });

  it("the interface is implementable by a fake (no network in tests)", async () => {
    const fake: LlmProvider = { complete: async ({ prompt }) => `echo:${prompt}` };
    expect(await fake.complete({ prompt: "x" })).toBe("echo:x");
  });
});
