/**
 * LLM behind an adapter (DECISIONS D11): the intelligence layer (M6 — summaries,
 * agent replies) depends only on `LlmProvider`, so the concrete vendor (Anthropic
 * / Claude today) is a localized swap. The api key is read from the environment
 * and NEVER logged or folded into an error message.
 */

export interface LlmProvider {
  /** One-shot completion: an optional system prompt + a user prompt → reply text. */
  complete(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string>;
}

/** Default Claude model; overridable via ANTHROPIC_MODEL. A fast, capable tier
 *  suits in-session summaries + agent banter. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Anthropic (Claude) via the Messages API. POSTs to /v1/messages and returns the
 * text of the first content block. The key is sent only as the `x-api-key`
 * header; on a non-OK response we throw with the status code alone (never the key
 * or response body).
 */
export class AnthropicLlm implements LlmProvider {
  async complete(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string> {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!res.ok) {
      // Status only — never leak the api key or provider error body.
      throw new Error("LLM failed: " + res.status);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b) => b.type === "text")?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("LLM returned no text");
    }
    return text;
  }
}

/** Fallback when no key is configured: complete is unavailable, not silent. */
export class NullLlm implements LlmProvider {
  async complete(): Promise<string> {
    throw new Error("LLM unavailable: set ANTHROPIC_API_KEY");
  }
}

/**
 * The active provider: Anthropic when a non-empty ANTHROPIC_API_KEY is present,
 * otherwise the Null provider (which throws on use). Memoized.
 */
let cached: LlmProvider | null = null;
export function getLlmProvider(): LlmProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key === "") return new NullLlm();
  if (cached === null) cached = new AnthropicLlm();
  return cached;
}
