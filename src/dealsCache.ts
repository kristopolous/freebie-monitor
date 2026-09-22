import type { PersonalizedDeal } from './types.js';

// Matching runs a real ~20-30s LLM call — without this, every page load or
// refresh (now that the profile persists across them) re-triggers it.
// Sign-up bonuses and bank promos run for weeks, not minutes — realistically
// checking once a day is already more often than terms actually change. The
// manual Rescan button is there for anyone who wants a forced fresh pull
// sooner. In-memory is fine for a single-process demo; invalidated whenever
// the profile's answers change, since matching depends on them.
const TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { at: number; deals: PersonalizedDeal[] }>();

export function getCachedDeals(profileId: string): PersonalizedDeal[] | null {
  const entry = cache.get(profileId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(profileId);
    return null;
  }
  return entry.deals;
}

export function setCachedDeals(profileId: string, deals: PersonalizedDeal[]): void {
  cache.set(profileId, { at: Date.now(), deals });
}

export function invalidateDeals(profileId: string): void {
  cache.delete(profileId);
}
