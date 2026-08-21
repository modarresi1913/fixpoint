/**
 * Thin wrapper around z-ai-web-dev-sdk.
 *
 * Every agent calls `askLLM(system, user)` instead of touching the SDK
 * directly. That way:
 *  - prompts are uniform (system + single user turn);
 *  - we get one place to add retries / logging / token budgets later;
 *  - the agents stay pure functions of (state) -> (state).
 */
import ZAI from "z-ai-web-dev-sdk";

let _zai: ZAI | null = null;

async function getZai(): Promise<ZAI> {
  if (!_zai) {
    _zai = await ZAI.create();
  }
  return _zai;
}

export interface LLMOptions {
  /** When true, enables chain-of-thought before the final answer. */
  thinking?: boolean;
  /** Max retry attempts on transient errors (default 5). */
  maxRetries?: number;
}

function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

export async function askLLM(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions = {}
): Promise<string> {
  const { thinking = false, maxRetries = 5 } = options;
  const zai = await getZai();

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        thinking: { type: thinking ? "enabled" : "disabled" },
      });
      const content = response.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        throw new Error("Empty response from LLM");
      }
      return content;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        // Longer backoff for rate limits (429): start at 10s, grow exponentially.
        // For other errors: short backoff.
        const base = isRateLimited(err) ? 10_000 : 1_000;
        const wait = base * Math.pow(2, attempt - 1);
        console.warn(
          `  [llm] attempt ${attempt}/${maxRetries} failed (${
            isRateLimited(err) ? "429" : "error"
          }); waiting ${wait}ms…`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

/**
 * Ask the LLM and parse the response as JSON. We strip markdown fences
 * (```json ... ```) defensively because models love to add them even
 * when explicitly told not to.
 */
export async function askLLMJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions = {}
): Promise<T> {
  const raw = await askLLM(
    systemPrompt + "\n\nRespond with valid JSON only. No markdown, no prose.",
    userPrompt,
    options
  );
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last-ditch: try to find the first { ... last } substring.
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1)) as T;
    }
    throw new Error(`LLM did not return valid JSON. Raw:\n${raw.slice(0, 500)}`);
  }
}
