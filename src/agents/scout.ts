import { z } from 'zod';
import { fetchDealCandidates, fetchRawOfferPages, brightDataIsLive } from '../integrations/brightdata.js';
import { hasModelCredentials, getModel, isUsingLocalModel } from '../integrations/model.js';
import { callLocalModelStructured } from '../integrations/localModel.js';
import type { DealCandidate } from '../types.js';

const ExtractedDealSchema = z.object({
  deals: z.array(
    z.object({
      institution: z.string(),
      title: z.string(),
      category: z.enum(['travel-card', 'cashback-card', 'bank-bonus', 'store-card', 'airline']),
      headlineValue: z.string(),
      requirement: z.string(),
      requirementDays: z.number().int().positive(),
    }),
  ),
});

/**
 * Scout: "The Web" — finds the current universe of reward/bonus offers.
 * When Bright Data and a model are both configured, this fetches raw
 * offer pages and has an Agent extract them into structured deals.
 * Otherwise it returns the seed/live candidate set from brightdata.ts,
 * which is already structured.
 */
export async function runScout(): Promise<DealCandidate[]> {
  const seedCandidates = await fetchDealCandidates();

  // Live extraction (3 real Bright Data unlocks + an LLM parse of noisy
  // SERP HTML) genuinely works but costs ~30-45s even with the timeout
  // guard below — too slow to sit on the hot path of every /api/deals
  // call in a live demo. Opt in explicitly once you're on infra fast
  // enough to afford it; seed data is the fast, always-on default.
  if (!brightDataIsLive() || !hasModelCredentials() || process.env.SCOUT_LIVE_EXTRACTION !== 'true') {
    return seedCandidates;
  }

  const pages = await fetchRawOfferPages([
    'best credit card sign up bonus this month site:doctorofcredit.com',
    'bank account opening bonus this month',
    'airline credit card bonus miles this month',
  ]);
  if (pages.length === 0) return seedCandidates;

  try {
    const systemPrompt =
      'You are the Scout agent for a personal rewards assistant. Extract concrete, ' +
      'currently-live sign-up bonus / reward offers from the raw web content you are given. ' +
      'Only extract offers with a clear headline value and a clear spend/deposit requirement ' +
      'with a deadline in days. Do not invent offers not present in the text.';
    // Raw SERP HTML is mostly noise — keep the slice small so a slower
    // model still has a chance of finishing inside the timeout below.
    const userPrompt =
      `Extract reward/bonus offers from this content:\n\n${pages.join('\n---\n').slice(0, 4_000)}\n\n` +
      `Reply as JSON: {"deals": [{"institution": string, "title": string, ` +
      `"category": "travel-card"|"cashback-card"|"bank-bonus"|"store-card"|"airline", ` +
      `"headlineValue": string, "requirement": string, "requirementDays": number}]}`;

    const extraction = isUsingLocalModel()
      ? callLocalModelStructured(ExtractedDealSchema, systemPrompt, userPrompt)
      : (async () => {
          const { Agent } = await import('@strands-agents/sdk');
          const model = await getModel();
          const agent = new Agent({ model, systemPrompt, structuredOutputSchema: ExtractedDealSchema });
          const result = await agent.invoke(userPrompt);
          return result.structuredOutput as z.infer<typeof ExtractedDealSchema> | undefined;
        })();

    // A slow model extracting from noisy scraped HTML must never hang the
    // whole /api/deals request — fall back to seed data past this budget.
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000));
    const structured = await Promise.race([extraction, timeout]);

    const extracted = structured?.deals ?? [];
    const liveDeals: DealCandidate[] = extracted.map((d, i) => ({
      id: `live-${i}-${d.institution.toLowerCase().replace(/\W+/g, '-')}`,
      institution: d.institution,
      title: d.title,
      category: d.category,
      headlineValue: d.headlineValue,
      requirement: d.requirement,
      requirementDays: d.requirementDays,
      sourceUrl: '',
      source: 'live',
    }));

    return liveDeals.length > 0 ? liveDeals : seedCandidates;
  } catch (err) {
    console.warn('[scout] model extraction failed, falling back to seed/live candidates:', err);
    return seedCandidates;
  }
}
