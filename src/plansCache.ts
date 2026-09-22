import type { ExecutionPlan } from './types.js';

// Strategist's plan generation is a real ~15-25s LLM call — clicking "I'm doing this" on the
// same deal shouldn't pay that every time. The ticket SHAPE for a given deal (what to do, in
// what order) is essentially deal-specific, not profile-specific, so this is keyed by dealId
// alone and shared across everyone tracking that deal — same tradeoff as dealsCache.ts.
// Short TTL because cached deadlines are baked in as absolute dates at generation time; a long
// TTL would let those drift stale.
const TTL_MS = 20 * 60 * 1000;

const cache = new Map<string, { at: number; plan: ExecutionPlan }>();

export function getCachedPlan(dealId: string): ExecutionPlan | null {
  const entry = cache.get(dealId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(dealId);
    return null;
  }
  return entry.plan;
}

export function setCachedPlan(dealId: string, plan: ExecutionPlan): void {
  cache.set(dealId, { at: Date.now(), plan });
}
