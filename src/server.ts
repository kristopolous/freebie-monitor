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
import { getProfile, listCommitments, saveCommitment, saveProfile, updateProfile, toggleTicket, reportTicketProgress } from './store.js';
import { computeNag } from './nag.js';
import { getCachedDeals, setCachedDeals, invalidateDeals } from './dealsCache.js';
import { getCachedPlan, setCachedPlan } from './plansCache.js';
import type { Commitment, PersonalizedDeal } from './types.js';

const app = new Hono();

const OnboardingSchema = z.object({
  ownsHome: z.boolean(),
  flightsPerYear: z.enum(['none', 'a-few', 'frequent']),
  idleCashBracket: z.enum(['none', 'under-10k', '10k-50k', '50k-plus']),
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

  const profile = await updateProfile(c.req.param('id'), parsed.data);
  if (!profile) return c.json({ error: 'unknown profile' }, 404);
  await mirrorAnswersToCognee(profile.id, parsed.data);
  await invalidateDeals(profile.id); // matching depends on the answers that just changed

  return c.json({ profile });
});

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
  let plan = getCachedPlan(deal.id);
  if (!plan) {
    plan = await runStrategist(deal, profile);
    setCachedPlan(deal.id, plan);
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

app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Freebie Monitor running at http://localhost:${info.port} (all interfaces, incl. Tailscale)`);
});
