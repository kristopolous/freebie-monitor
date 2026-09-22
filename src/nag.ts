import type { Commitment, Ticket } from './types.js';
import { actionableTickets, isTicketComplete } from './ticket.js';

function ticketLabel(t: Ticket): string {
  if (t.kind === 'target') {
    const remaining = Math.max(0, (t.targetAmount ?? 0) - (t.currentAmount ?? 0));
    return `${t.unit ?? '$'}${remaining.toLocaleString()} more on "${t.title}"`;
  }
  return t.title;
}

/**
 * Deterministic, no LLM call — this runs on every GET /api/commitments, so
 * it has to be fast and reliable, not another thing that can hang or drift.
 * Points at the single most urgent incomplete ticket by name, not just a
 * generic "you're behind" — that's what makes it a nag worth reading.
 */
export function computeNag(commitment: Commitment): string | null {
  if (commitment.status !== 'tracking') return null;

  const now = Date.now();
  const incomplete = actionableTickets(commitment.plan.tickets).filter((t) => !isTicketComplete(t));
  if (incomplete.length === 0) return null;

  const withDays = incomplete
    .map((t) => ({ ticket: t, daysLeft: Math.round((new Date(t.deadline).getTime() - now) / 86_400_000) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const most = withDays[0];

  if (most.daysLeft < 0) {
    return `Overdue: ${ticketLabel(most.ticket)} was due ${Math.abs(most.daysLeft)} day${Math.abs(most.daysLeft) === 1 ? '' : 's'} ago — check if the $${commitment.personalValueUsd} ${commitment.institution} bonus is still salvageable.`;
  }

  if (most.daysLeft <= 5) {
    return `${ticketLabel(most.ticket)} — due in ${most.daysLeft} day${most.daysLeft === 1 ? '' : 's'} on the $${commitment.personalValueUsd} ${commitment.institution} bonus.`;
  }

  return null;
}
