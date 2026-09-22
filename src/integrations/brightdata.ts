import type { DealCandidate } from '../types.js';
import { SEED_DEALS } from '../seed/deals.js';

// "The Web": live discovery of current sign-up bonuses / rewards offers.
// Real mode uses Bright Data's Web Unlocker API to fetch search results
// pages, which agents/scout.ts hands to the model to extract structured
// deals. Until BRIGHTDATA_API_KEY is set, everything runs on the curated
// seed set so the rest of the pipeline has real data to work with today.

export function brightDataIsLive(): boolean {
  return Boolean(process.env.BRIGHTDATA_API_KEY);
}

// Real Web Unlocker requests take 10-20s each (genuine anti-bot unblocking
// overhead, not a bug) — run them in parallel with a per-request timeout so
// three queries cost ~20s total instead of ~50s sequential.
export async function fetchRawOfferPages(queries: string[], timeoutMs = 20_000): Promise<string[]> {
  if (!brightDataIsLive()) return [];

  const zone = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';

  const results = await Promise.all(
    queries.map(async (query) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch('https://api.brightdata.com/request', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            zone,
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
            format: 'raw',
          }),
          signal: controller.signal,
        });
        return res.ok ? await res.text() : null;
      } catch {
        // one failed/timed-out query shouldn't sink the whole scout pass
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return results.filter((r): r is string => r !== null);
}

// The seed set is the floor the rest of the pipeline always has to work
// with — it never touches Bright Data itself. Live extraction from
// fetchRawOfferPages() happens separately in agents/scout.ts, which layers
// on top of (not instead of) this.
export async function fetchDealCandidates(): Promise<DealCandidate[]> {
  return SEED_DEALS;
}
