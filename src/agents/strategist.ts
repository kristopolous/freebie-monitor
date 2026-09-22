import { z } from 'zod';
import { hasModelCredentials, getModel, isUsingLocalModel } from '../integrations/model.js';
import { callLocalModelStructured } from '../integrations/localModel.js';
import type { ExecutionPlan, PersonalizedDeal, Profile, Ticket } from '../types.js';

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function artifactKindFor(deal: PersonalizedDeal): ExecutionPlan['artifact']['kind'] {
  if (deal.category === 'bank-bonus') return 'reminder-set';
  if (deal.category === 'store-card') return 'reminder-set';
  return 'spend-plan';
}

function parseTargetAmount(requirement: string): number | null {
  const m = requirement.match(/\$([0-9][0-9,]*)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseSubDeadlineDays(requirement: string, fallback: number): number {
  const m = requirement.match(/within (\d+) days?/i);
  return m ? Number(m[1]) : fallback;
}

// The artifact text (both the model and the heuristic fallback write it as
// "Day N — do this check-in") reads like a reminder schedule, but prose in a
// one-time confirmation dialog isn't actually a reminder — it never shows up
// on the calendar or the To-Do list again once the dialog is closed. Pull
// each "Day N — ..." line out as a real 'deadline' ticket so it's genuinely
// tracked, instead of trusting the model to have also encoded it that way.
function extractReminderTickets(content: string): Ticket[] {
  const tickets: Ticket[] = [];
  const seenDays = new Set<number>();
  for (const m of content.matchAll(/Day\s+(\d+)\s*[—–-]\s*([^\n]+)/gi)) {
    const day = Number(m[1]);
    if (!Number.isFinite(day) || seenDays.has(day)) continue;
    seenDays.add(day);
    const title = m[2].trim().replace(/\s+/g, ' ').slice(0, 140);
    tickets.push({ title: `Check-in: ${title}`, kind: 'deadline', deadline: addDays(day) });
  }
  return tickets;
}

function heuristicPlan(deal: PersonalizedDeal, profile: Profile): ExecutionPlan {
  const kind = artifactKindFor(deal);
  const targetAmount = parseTargetAmount(deal.requirement);
  const subDeadlineDays = parseSubDeadlineDays(deal.requirement, Math.max(1, Math.round(deal.requirementDays / 3)));

  const tickets: Ticket[] = [
    { title: `Open the ${deal.title} account`, kind: 'action', deadline: addDays(1) },
    targetAmount
      ? {
          title: `Deposit/spend to meet the requirement`,
          kind: 'target',
          targetAmount,
          currentAmount: 0,
          unit: '$',
          deadline: addDays(subDeadlineDays),
        }
      : { title: `Meet the requirement: ${deal.requirement}`, kind: 'action', deadline: addDays(subDeadlineDays) },
    { title: `Maintain it through the full window`, kind: 'action', deadline: addDays(deal.requirementDays) },
    { title: `Bonus/points should post`, kind: 'deadline', deadline: addDays(deal.requirementDays + 10) },
  ];

  const content =
    kind === 'spend-plan'
      ? `Tracking plan for ${deal.title}\n` +
        `Target: ${deal.requirement}\n` +
        `Suggested pace: route recurring bills/subscriptions to this card until the requirement is met, ` +
        `well before day ${deal.requirementDays}.`
      : `Tracking plan for ${deal.title}\n` +
        `Requirement: ${deal.requirement}\n` +
        `Your agent checks in at day 1, day ${Math.round(deal.requirementDays / 2)}, and day ${deal.requirementDays - 3}.`;

  return {
    dealId: deal.id,
    profileId: profile.id,
    tickets: [...tickets, ...extractReminderTickets(content)],
    deadline: addDays(deal.requirementDays),
    deadlineDays: deal.requirementDays,
    artifact: { kind, content },
    sandboxLog: '',
  };
}

const PlanSchema = z.object({
  tickets: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(['action', 'target', 'deadline']),
      deadlineDays: z.number().int().nonnegative(),
      targetAmount: z.number().positive().optional(),
      unit: z.string().optional(),
    }),
  ),
  artifactKind: z.enum(['spend-plan', 'retention-script', 'reminder-set']),
  artifactContent: z.string(),
});

/**
 * Strategist: breaks a matched deal down into tickets — concrete, dated
 * things the PERSON does and self-reports (open an account, hit a deposit
 * target, know when points expire). This never performs the actions; it
 * plans them and hands off tracking to the checklist.
 */
export async function runStrategist(deal: PersonalizedDeal, profile: Profile): Promise<ExecutionPlan> {
  if (!hasModelCredentials()) {
    return heuristicPlan(deal, profile);
  }

  try {
    const systemPrompt =
      'You are the Strategist agent for a personal rewards tracker. Given a matched reward offer ' +
      'and its requirement text, break it into 3-5 concrete tickets the PERSON needs to do and ' +
      "self-report — you are not an agent that performs these actions. Use kind 'action' for a " +
      "one-off thing to check off (e.g. \"Open the account\"), kind 'target' for a number the " +
      "person deposits/spends toward over time (set targetAmount and unit, e.g. targetAmount: 500, " +
      "unit: \"$\"), and kind 'deadline' for a pure awareness date with nothing to do (e.g. " +
      '"Points expire"). Give each ticket its own deadlineDays (days from today) — sub-deadlines ' +
      'inside the overall window are common (e.g. a deposit due in 20 days within a 60-day window). ' +
      'Also produce a single artifact: either a spend-plan (how to route spending to hit a ' +
      'minimum-spend requirement), a retention-script (what to say if negotiating to keep/downgrade ' +
      'an account before a fee hits), or a reminder-set (when to check in before a deposit/balance ' +
      'deadline). Be specific and actionable, not generic advice.';
    const userPrompt =
      `Offer: ${deal.title} from ${deal.institution}\n` +
      `Value to this person: ~$${deal.personalValueUsd}\n` +
      `Requirement: ${deal.requirement}\n` +
      `Overall deadline: ${deal.requirementDays} days from today.\n\n` +
      `Reply as JSON: {"tickets": [{"title": string, "kind": "action"|"target"|"deadline", ` +
      `"deadlineDays": number, "targetAmount": number (only for target), "unit": string (only for target)}], ` +
      `"artifactKind": "spend-plan"|"retention-script"|"reminder-set", "artifactContent": string}`;

    const structured = isUsingLocalModel()
      ? await callLocalModelStructured(PlanSchema, systemPrompt, userPrompt)
      : await (async () => {
          const { Agent } = await import('@strands-agents/sdk');
          const model = await getModel();
          const agent = new Agent({ model, systemPrompt, structuredOutputSchema: PlanSchema });
          const result = await agent.invoke(userPrompt);
          return result.structuredOutput as z.infer<typeof PlanSchema> | undefined;
        })();

    if (!structured || structured.tickets.length === 0) return heuristicPlan(deal, profile);

    const tickets: Ticket[] = structured.tickets.map((t) => ({
      title: t.title,
      kind: t.kind,
      deadline: addDays(t.deadlineDays),
      ...(t.kind === 'action' ? { done: false } : {}),
      ...(t.kind === 'target' ? { targetAmount: t.targetAmount ?? 0, currentAmount: 0, unit: t.unit ?? '$' } : {}),
    }));

    return {
      dealId: deal.id,
      profileId: profile.id,
      tickets: [...tickets, ...extractReminderTickets(structured.artifactContent)],
      deadline: addDays(deal.requirementDays),
      deadlineDays: deal.requirementDays,
      artifact: { kind: structured.artifactKind, content: structured.artifactContent },
      sandboxLog: '',
    };
  } catch (err) {
    console.warn('[strategist] model call failed, falling back to heuristic plan:', err);
    return heuristicPlan(deal, profile);
  }
}
