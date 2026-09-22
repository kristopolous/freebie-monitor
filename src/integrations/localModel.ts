import type { ZodType, z } from 'zod';
import { localModelBaseUrl, localModelId } from './model.js';
import { fetchWithTimeout } from './fetchTimeout.js';

const LOCAL_MODEL_TIMEOUT_MS = 45_000;

/**
 * Calls the local OpenAI-compatible endpoint directly with a plain,
 * non-streaming chat completion, asking for raw JSON in the reply and
 * validating it against `schema`. Bypasses the Strands SDK's tool-calling
 * machinery entirely — see model.ts's isUsingLocalModel() for why.
 *
 * Returns null (never throws for a malformed reply) so callers can fall
 * back to the heuristic path the same way a thrown error would trigger it.
 */
export async function callLocalModelStructured<S extends ZodType>(
  schema: S,
  systemPrompt: string,
  userPrompt: string,
): Promise<z.infer<S> | null> {
  const res = await fetchWithTimeout(
    `${localModelBaseUrl()}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LOCAL_MODEL_API_KEY || 'local'}`,
      },
      body: JSON.stringify({
        model: localModelId(),
        stream: false,
        messages: [
          {
            role: 'system',
            content: `${systemPrompt}\n\nReply with ONLY a raw JSON object matching the requested shape — no markdown code fences, no commentary before or after.`,
          },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
    LOCAL_MODEL_TIMEOUT_MS,
  );

  if (!res.ok) throw new Error(`Local model request failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) return null;

  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}
