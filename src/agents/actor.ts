import { runInDockerSandbox } from '../integrations/sandbox.js';
import { getCogneeClient } from '../integrations/cognee.js';
import type { ExecutionPlan, PersonalizedDeal, Profile, Ticket } from '../types.js';

function ticketLine(t: Ticket, i: number): string {
  const due = new Date(t.deadline).toISOString().slice(0, 10);
  if (t.kind === 'target') return `${i + 1}. [target] ${t.title} — 0/${t.targetAmount}${t.unit ?? ''} by ${due}`;
  if (t.kind === 'deadline') return `${i + 1}. [deadline] ${t.title} — ${due}`;
  return `${i + 1}. [ ] ${t.title} — by ${due}`;
}

function shellScriptFor(deal: PersonalizedDeal, plan: ExecutionPlan): string {
  const escapedArtifact = plan.artifact.content.replace(/'/g, "'\\''");
  const ticketText = plan.tickets.map(ticketLine).join('\n');
  const escapedTickets = ticketText.replace(/'/g, "'\\''");
  return [
    `echo '[actor] setting up tracking for: ${deal.title.replace(/'/g, "'\\''")}'`,
    `echo '[actor] this does not sign anyone up for anything — the person does that themselves'`,
    `mkdir -p /tmp/out`,
    `cat > /tmp/out/tickets.txt <<'TICKETS_EOF'\n${escapedTickets}\nTICKETS_EOF`,
    `cat > /tmp/out/artifact.txt <<'ARTIFACT_EOF'\n${escapedArtifact}\nARTIFACT_EOF`,
    `echo '[actor] tickets written:'`,
    `cat /tmp/out/tickets.txt`,
    `echo '[actor] deadline: ${plan.deadline}'`,
    `echo '[actor] tracking initialized.'`,
  ].join('\n');
}

/**
 * Actor: "The Sandbox" — sets up tracking for a matched deal inside a
 * throwaway Docker container (real, local, no sponsor credit needed) and
 * writes it into the Cognee-held graph so the agent remembers to nag
 * before the deadline. It never opens accounts or signs anyone up for
 * anything — that stays a human action, self-reported through tickets.
 */
export async function runActor(deal: PersonalizedDeal, plan: ExecutionPlan, profile: Profile): Promise<ExecutionPlan> {
  const script = shellScriptFor(deal, plan);
  const sandboxResult = await runInDockerSandbox(script);

  const cognee = getCogneeClient();
  await cognee.addFacts(profile.id, [
    `TRACKING: this person is pursuing "${deal.title}" (${deal.institution}), worth ~$${deal.personalValueUsd}, ` +
      `requirement "${deal.requirement}", deadline ${plan.deadline}, ${plan.tickets.length} tickets, status tracking.`,
  ]);

  return { ...plan, sandboxLog: sandboxResult.log };
}
