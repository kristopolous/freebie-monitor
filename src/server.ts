try {
  process.loadEnvFile();
} catch {
  // no .env file present — fine in prod where the env is set externally
}

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { runScout } from './agents/scout.js';
import { runMatcher } from './agents/matcher.js';
import { runStrategist } from './agents/strategist.js';
import { runActor } from './agents/actor.js';
import { getCogneeClient } from './integrations/cognee.js';
import { hasModelCredentials } from './integrations/model.js';
import { brightDataIsLive } from './integrations/brightdata.js';
import { dockerIsAvailable } from './integrations/sandbox.js';
import {
  getProfile,
  listCommitments,
  saveCommitment,
  saveProfile,
  updateProfile,
  toggleTicket,
  reportTicketProgress,
  cancelCommitment,
  reactivateCommitment,
} from './store.js';
import { computeNag } from './nag.js';
import { getCachedDeals, setCachedDeals, invalidateDeals } from './dealsCache.js';
import { getCachedPlan, setCachedPlan } from './plansCache.js';
import type { Commitment, PersonalizedDeal } from './types.js';

const app = new Hono();

const OnboardingSchema = z.object({
  ownsHome: z.boolean(),
  flightsPerYear: z.enum(['none', 'a-few', 'frequent']),
  idleCashBracket: z.enum(['none', 'under-10k', '10k-50k', '50k-plus']),
  monthlyDirectDeposit: z.enum(['none', 'under-1k', '1k-3k', '3k-10k', '10k-plus']),
  bigBoxShopper: z.boolean(),
  openToNewAccounts: z.boolean(),
  primaryGoal: z.enum(['travel', 'cashback', 'either']),
});

app.get('/api/status', async (c) => {
  return c.json({
    cognee: getCogneeClient().mode,
    brightData: brightDataIsLive() ? 'live' : 'seed',
    model: hasModelCredentials() ? 'live' : 'heuristic',
    docker: (await dockerIsAvailable()) ? 'available' : 'unavailable',
  });
});

async function mirrorAnswersToCognee(profileId: string, a: z.infer<typeof OnboardingSchema>) {
  const cognee = getCogneeClient();
  await cognee.addFacts(profileId, [
    `Owns a home: ${a.ownsHome}.`,
    `Flights per year: ${a.flightsPerYear}.`,
    `Idle cash sitting around: ${a.idleCashBracket}.`,
    `Shops at big-box retailers (Lowe's/Home Depot/etc.): ${a.bigBoxShopper}.`,
    `Open to opening new financial accounts for bonuses: ${a.openToNewAccounts}.`,
    `Primary reward goal: ${a.primaryGoal}.`,
  ]);
  await cognee.cognify(profileId);
}

app.post('/api/onboard', async (c) => {
  const body = await c.req.json();
  const parsed = OnboardingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

  const profile = await saveProfile({ answers: parsed.data });
  await mirrorAnswersToCognee(profile.id, parsed.data);

  return c.json({ profile });
});

// Restores state on refresh (frontend keeps the profile id in
// localStorage) and prefills the settings view.
app.get('/api/profile/:id', async (c) => {
  const profile = await getProfile(c.req.param('id'));
  if (!profile) return c.json({ error: 'unknown profile' }, 404);
  return c.json({ profile });
});

app.patch('/api/profile/:id', async (c) => {
  const body = await c.req.json();
  const parsed = OnboardingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

  const before = await getProfile(c.req.param('id'));
  if (!before) return c.json({ error: 'unknown profile' }, 404);

  // Opening Settings and hitting Save with nothing actually changed must not
  // burn a real, paid Cognee write + Bright Data/LLM re-scan - both are
  // real API costs, not free lookups, and matching only needs to re-run
  // when the answers it depends on actually changed.
  const changed = JSON.stringify(before.answers) !== JSON.stringify(parsed.data);

  const profile = await updateProfile(c.req.param('id'), parsed.data);
  if (!profile) return c.json({ error: 'unknown profile' }, 404);
  if (changed) {
    await mirrorAnswersToCognee(profile.id, parsed.data);
    await invalidateDeals(profile.id);
  }

  return c.json({ profile, changed });
});

// Builds and caches the Strategist plan for every deal a scan just returned, so clicking
// "I'm doing this" later is a cache hit instead of a fresh ~15-25s LLM call. Fire-and-forget:
// runs after the response for THIS request is already on its way, never blocks Drops from
// showing. Plans are keyed by dealId alone (see plansCache.ts) so this warms the cache for
// every future profile that sees the same deal too, not just this one.
async function prewarmPlans(deals: PersonalizedDeal[], profile: NonNullable<Awaited<ReturnType<typeof getProfile>>>) {
  for (const deal of deals) {
    if (await getCachedPlan(deal.id)) continue;
    try {
      const plan = await runStrategist(deal, profile);
      await setCachedPlan(deal.id, plan);
    } catch (err) {
      console.warn('[prewarm] plan generation failed for', deal.id, err);
    }
  }
}

app.get('/api/deals', async (c) => {
  const profileId = c.req.query('profileId');
  if (!profileId) return c.json({ error: 'profileId required' }, 400);
  const profile = await getProfile(profileId);
  if (!profile) return c.json({ error: 'unknown profile' }, 404);

  const force = c.req.query('force') === 'true';
  if (!force) {
    const cached = await getCachedDeals(profileId);
    if (cached) return c.json({ deals: cached, cached: true });
  }

  const candidates = await runScout();
  const deals = await runMatcher(profile, candidates);
  await setCachedDeals(profileId, deals);
  void prewarmPlans(deals, profile);
  return c.json({ deals, cached: false });
});

const ExecuteSchema = z.object({
  profileId: z.string(),
  deal: z.custom<PersonalizedDeal>((v) => typeof v === 'object' && v !== null),
});

// The person is committing to pursue this deal themselves — this builds
// the checklist and starts tracking it, it does not sign anyone up for
// anything.
app.post('/api/deals/track', async (c) => {
  const body = await c.req.json();
  const parsed = ExecuteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

  const profile = await getProfile(parsed.data.profileId);
  if (!profile) return c.json({ error: 'unknown profile' }, 404);

  const deal = parsed.data.deal;

  // Clicking "I'm doing this" again on a deal already being actively
  // tracked reopens that same commitment instead of creating a duplicate -
  // also skips paying for another Strategist/Actor run.
  const existing = (await listCommitments(profile.id)).find((c) => c.dealId === deal.id && c.status === 'tracking');
  if (existing) return c.json({ commitment: existing });

  let plan = await getCachedPlan(deal.id);
  if (!plan) {
    plan = await runStrategist(deal, profile);
    await setCachedPlan(deal.id, plan);
  }
  const trackedPlan = await runActor(deal, plan, profile);

  const commitment = await saveCommitment({
    profileId: profile.id,
    dealId: deal.id,
    dealTitle: deal.title,
    institution: deal.institution,
    personalValueUsd: deal.personalValueUsd,
    deadline: trackedPlan.deadline,
    plan: trackedPlan,
  });

  return c.json({ commitment });
});

app.get('/api/commitments', async (c) => {
  const profileId = c.req.query('profileId');
  if (!profileId) return c.json({ error: 'profileId required' }, 400);
  const commitments = await listCommitments(profileId);
  const withNags = commitments.map((commitment) => ({ ...commitment, nag: computeNag(commitment) }));
  return c.json({ commitments: withNags });
});

// Cognee only ever heard about onboarding answers and the moment tracking started — every
// checked-off ticket and reported dollar figure since was invisible to the person's memory
// graph. Mirroring these in means later reasoning (in this session or a future one) can draw
// on the person's actual follow-through, not just their day-one snapshot — including a
// genuinely useful signal for eligibility: a past COMPLETED fact for an issuer is exactly what
// a once-per-X-months rule needs to check against.
async function mirrorTicketEventToCognee(profileId: string, commitment: Commitment, ticketIndex: number) {
  const ticket = commitment.plan.tickets[ticketIndex];
  if (!ticket) return;
  const cognee = getCogneeClient();
  const facts = [
    `PROGRESS: on "${commitment.dealTitle}" (${commitment.institution}), ticket "${ticket.title}" ` +
      (ticket.kind === 'target'
        ? `now at $${(ticket.currentAmount ?? 0).toLocaleString()} of $${(ticket.targetAmount ?? 0).toLocaleString()}.`
        : `marked ${ticket.done ? 'done' : 'not done'}.`),
  ];
  if (commitment.status === 'fulfilled') {
    facts.push(
      `COMPLETED: this person successfully earned "${commitment.dealTitle}" (${commitment.institution}), ` +
        `worth $${commitment.personalValueUsd.toLocaleString()}. Relevant for future eligibility checks on this institution.`,
    );
  }
  await cognee.addFacts(profileId, facts);
}

const ToggleTicketSchema = z.object({ done: z.boolean() });

// The person checks an 'action' ticket off once they've actually done it —
// this endpoint never runs on its own.
app.post('/api/commitments/:id/tickets/:index/toggle', async (c) => {
  const body = await c.req.json();
  const parsed = ToggleTicketSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

  const id = c.req.param('id');
  const ticketIndex = Number(c.req.param('index'));
  if (!Number.isInteger(ticketIndex) || ticketIndex < 0) return c.json({ error: 'invalid ticket index' }, 400);

  const commitment = await toggleTicket(id, ticketIndex, parsed.data.done);
  if (!commitment) return c.json({ error: 'unknown commitment or ticket' }, 404);
  await mirrorTicketEventToCognee(commitment.profileId, commitment, ticketIndex);

  return c.json({ commitment: { ...commitment, nag: computeNag(commitment) } });
});

// The person backs out of a deal they'd committed to before it's fulfilled —
// drops it off the active To-Do/nag list without erasing the history.
app.post('/api/commitments/:id/cancel', async (c) => {
  const commitment = await cancelCommitment(c.req.param('id'));
  if (!commitment) return c.json({ error: 'unknown commitment, or already fulfilled' }, 404);
  return c.json({ commitment });
});

// Undoes a cancel — nothing about backing out should be a one-way door.
app.post('/api/commitments/:id/reactivate', async (c) => {
  const commitment = await reactivateCommitment(c.req.param('id'));
  if (!commitment) return c.json({ error: 'unknown commitment, or not cancelled' }, 404);
  return c.json({ commitment });
});

const ReportProgressSchema = z.object({ currentAmount: z.number().nonnegative() });

// The person self-reports progress on a 'target' ticket, e.g. "I've
// deposited $400 of $500" — never inferred or automated.
app.post('/api/commitments/:id/tickets/:index/report', async (c) => {
  const body = await c.req.json();
  const parsed = ReportProgressSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

  const id = c.req.param('id');
  const ticketIndex = Number(c.req.param('index'));
  if (!Number.isInteger(ticketIndex) || ticketIndex < 0) return c.json({ error: 'invalid ticket index' }, 400);

  const commitment = await reportTicketProgress(id, ticketIndex, parsed.data.currentAmount);
  if (!commitment) return c.json({ error: 'unknown commitment or ticket' }, 404);
  await mirrorTicketEventToCognee(commitment.profileId, commitment, ticketIndex);

  return c.json({ commitment: { ...commitment, nag: computeNag(commitment) } });
});

// Without this, browsers heuristically cache app.js/style.css/index.html on
// their own schedule with no explicit expiry to key off - a shipped fix can
// silently sit uninstalled in someone's browser through any number of
// ordinary reloads, only visible as "I did that and nothing changed."
// no-cache still allows caching, it just forces a revalidation round-trip
// (cheap, conditional) on every load instead of trusting a stale copy.
app.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-cache');
});
app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Freebie Monitor running at http://localhost:${info.port} (all interfaces, incl. Tailscale)`);
});
