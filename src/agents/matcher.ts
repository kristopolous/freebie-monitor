import { z } from 'zod';
import { getCogneeClient } from '../integrations/cognee.js';
import { hasModelCredentials, getModel, isUsingLocalModel } from '../integrations/model.js';
import { callLocalModelStructured } from '../integrations/localModel.js';
import type { DealCandidate, OnboardingAnswers, PersonalizedDeal, Profile } from '../types.js';

function parseUsdEstimate(deal: DealCandidate): number {
  // A headline can mention a small dollar figure (e.g. a "$99 companion fare")
  // alongside a much larger points/miles bonus — the points bonus is usually
  // the actual reward, so when both are present, take whichever estimate is
  // larger rather than just the first $ figure found.
  const dollarMatches = [...deal.headlineValue.matchAll(/\$([0-9][0-9,]*)/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  const dollarEstimate = dollarMatches.length > 0 ? Math.max(...dollarMatches) : 0;

  const pointsMatch = deal.headlineValue.match(/([0-9][0-9,]*)\s*(points|miles)/i);
  const pointsEstimate = pointsMatch ? Math.round(Number(pointsMatch[1].replace(/,/g, '')) * 0.01) : 0;

  const best = Math.max(dollarEstimate, pointsEstimate);
  return best > 0 ? best : 100;
}

interface ScoredDeal {
  relevanceScore: number;
  personalValueUsd: number;
  reasoning: string;
}

function heuristicScore(deal: DealCandidate, answers: OnboardingAnswers): ScoredDeal | null {
  if (!answers.openToNewAccounts) return null; // every deal here requires opening a new account

  let score = 40;
  const reasons: string[] = [];
  const usd = parseUsdEstimate(deal);

  if (deal.category === 'store-card') {
    if (answers.ownsHome) {
      score += 30;
      reasons.push('you own a home, so a home-improvement store card sees real use');
    } else {
      score -= 25;
      reasons.push("you don't own a home, so this store card mostly sits unused");
    }
    if (answers.bigBoxShopper) {
      score += 15;
      reasons.push('you already shop at big-box retailers like this one');
    }
  }

  if (deal.category === 'airline' || deal.category === 'travel-card') {
    if (answers.flightsPerYear === 'frequent') {
      score += 35;
      reasons.push('you fly frequently, so travel rewards convert to real trips fast');
    } else if (answers.flightsPerYear === 'a-few') {
      score += 10;
      reasons.push('you fly occasionally, so this has some use to you');
    } else {
      score -= 30;
      reasons.push("you said you rarely fly, so travel points would mostly go to waste");
    }
    if (answers.primaryGoal === 'travel') score += 15;
  }

  if (deal.category === 'bank-bonus') {
    const needsBigBalance = /100,?000|50,?000/.test(deal.requirement);
    if (needsBigBalance) {
      if (answers.idleCashBracket === '50k-plus') {
        score += 40;
        reasons.push("you're sitting on $50k+ in idle cash — this beats what it's earning you now");
      } else {
        score -= 40;
        reasons.push("this needs a six-figure balance you don't have sitting idle");
      }
    } else {
      if (answers.idleCashBracket === 'none') {
        score -= 20;
        reasons.push("you don't have idle cash to park for the deposit requirement");
      } else {
        score += 15;
        reasons.push('you have cash on hand that could cover the deposit requirement');
      }
    }
    if (answers.primaryGoal === 'cashback') score += 10;
  }

  if (deal.category === 'cashback-card' && answers.primaryGoal !== 'travel') {
    score += 10;
    reasons.push('straight cashback fits what you said you actually want');
  }

  score = Math.max(0, Math.min(100, score));
  const reasoning =
    reasons.length > 0
      ? `Worth ~$${usd.toLocaleString()} to you: ${reasons.join('; ')}.`
      : `Worth ~$${usd.toLocaleString()}, a generic fit based on what you told us.`;

  return { relevanceScore: score, personalValueUsd: usd, reasoning };
}

const MatchSchema = z.object({
  matches: z.array(
    z.object({
      dealId: z.string(),
      relevanceScore: z.number().min(0).max(100),
      personalValueUsd: z.number().nonnegative(),
      reasoning: z.string(),
    }),
  ),
});

/**
 * Matcher: cross-references each candidate deal against the profile's
 * Cognee-held personal-context graph and scores how much it's actually
 * worth to *this* person, not a generic audience.
 */
export async function runMatcher(profile: Profile, candidates: DealCandidate[]): Promise<PersonalizedDeal[]> {
  // Hard, deterministic gate — every deal here requires opening a new
  // account, so this is known client-side and must never depend on the
  // model consistently applying it. (Previously only the heuristic path
  // enforced this; the LLM path would "honor" it by scoring to $0 instead
  // of omitting the deal, which read as a bug — a $300 bonus showing $0.)
  if (!profile.answers.openToNewAccounts) return [];

  const cognee = getCogneeClient();
  const facts = await cognee.allFacts(profile.id);

  // Cognee's actual value is graph reasoning over the stored facts, not
  // just storing them — so pull a synthesized summary through search()
  // (GRAPH_COMPLETION on live Cognee; keyword-ranked facts locally) rather
  // than only ever handing the raw fact list to the Matcher's own model call.
  const graphSummary = await cognee
    .search(
      profile.id,
      'Summarize what matters financially to this person: their spending habits, liquidity, travel patterns, and what kind of reward would actually be useful to them.',
    )
    .catch(() => []);

  if (hasModelCredentials()) {
    try {
      const systemPrompt =
        'You are the Matcher agent for a personal rewards assistant. You are given facts ' +
        "about a real person's life and a list of candidate reward offers. Score each offer " +
        "0-100 on relevance to THIS person specifically (not a generic audience), estimate what " +
        "it's actually worth to them in dollars, and give a one-sentence reason that cites the " +
        'specific personal fact that drove the score. Be honest: score low and explain why when ' +
        "an offer doesn't fit this person's life.";

      const prompt =
        `Known facts about this person:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` +
        (graphSummary.length > 0
          ? `Cognee's graph-reasoned summary of this person:\n${graphSummary.join('\n')}\n\n`
          : '') +
        `Candidate offers:\n${candidates
          .map((d) => `- id=${d.id} | ${d.institution}: ${d.title} | ${d.headlineValue} | requires: ${d.requirement}`)
          .join('\n')}\n\n` +
        `Reply as JSON: {"matches": [{"dealId": string, "relevanceScore": number, "personalValueUsd": number, "reasoning": string}]}`;

      const structured = isUsingLocalModel()
        ? await callLocalModelStructured(MatchSchema, systemPrompt, prompt)
        : await (async () => {
            const { Agent } = await import('@strands-agents/sdk');
            const model = await getModel();
            const agent = new Agent({ model, systemPrompt, structuredOutputSchema: MatchSchema });
            const result = await agent.invoke(prompt);
            return result.structuredOutput as z.infer<typeof MatchSchema> | undefined;
          })();

      const matches = structured?.matches ?? [];
      if (matches.length > 0) {
        const byId = new Map(matches.map((m) => [m.dealId, m]));
        return candidates
          .map((d) => {
            const m = byId.get(d.id);
            if (!m) return null;
            return { ...d, relevanceScore: m.relevanceScore, personalValueUsd: m.personalValueUsd, reasoning: m.reasoning };
          })
          .filter((d): d is PersonalizedDeal => d !== null)
          .sort((a, b) => b.relevanceScore - a.relevanceScore);
      }
    } catch (err) {
      // A flaky model (bad tool-call streaming, rate limit, timeout) should
      // degrade to the heuristic path below, not break the demo mid-flow.
      console.warn('[matcher] model call failed, falling back to heuristic scoring:', err);
    }
  }

  // Heuristic fallback — fully functional without a model key.
  return candidates
    .map((d) => {
      const scored = heuristicScore(d, profile.answers);
      if (!scored) return null;
      return { ...d, ...scored };
    })
    .filter((d): d is PersonalizedDeal => d !== null)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}
