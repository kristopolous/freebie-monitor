import type { Ticket } from './types.js';

/** 'deadline' tickets are informational only — they never block completion. */
export function isTicketComplete(ticket: Ticket): boolean {
  if (ticket.kind === 'target') return (ticket.currentAmount ?? 0) >= (ticket.targetAmount ?? Infinity);
  if (ticket.kind === 'action') return Boolean(ticket.done);
  return true;
}

export function actionableTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => t.kind !== 'deadline');
}
