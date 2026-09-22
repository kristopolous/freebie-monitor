import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Commitment, Profile } from './types.js';
import { actionableTickets, isTicketComplete } from './ticket.js';

const DATA_DIR = path.join(process.cwd(), '.data', 'store');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path.join(DATA_DIR, file), 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(file: string, data: T): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

export async function saveProfile(profile: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile> {
  const profiles = await readJson<Profile[]>('profiles.json', []);
  const full: Profile = { ...profile, id: randomUUID(), createdAt: new Date().toISOString() };
  profiles.push(full);
  await writeJson('profiles.json', profiles);
  return full;
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  const profiles = await readJson<Profile[]>('profiles.json', []);
  return profiles.find((p) => p.id === id);
}

export async function updateProfile(id: string, answers: Profile['answers']): Promise<Profile | undefined> {
  const profiles = await readJson<Profile[]>('profiles.json', []);
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return undefined;
  profile.answers = answers;
  await writeJson('profiles.json', profiles);
  return profile;
}

export async function saveCommitment(commitment: Omit<Commitment, 'id' | 'createdAt' | 'status'>): Promise<Commitment> {
  const commitments = await readJson<Commitment[]>('commitments.json', []);
  const full: Commitment = {
    ...commitment,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'tracking',
  };
  commitments.push(full);
  await writeJson('commitments.json', commitments);
  return full;
}

export async function listCommitments(profileId: string): Promise<Commitment[]> {
  const commitments = await readJson<Commitment[]>('commitments.json', []);
  return commitments
    .filter((c) => c.profileId === profileId)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
}

export async function getCommitment(id: string): Promise<Commitment | undefined> {
  const commitments = await readJson<Commitment[]>('commitments.json', []);
  return commitments.find((c) => c.id === id);
}

function refreshStatus(commitment: Commitment): void {
  const tickets = actionableTickets(commitment.plan.tickets);
  commitment.status = tickets.length > 0 && tickets.every(isTicketComplete) ? 'fulfilled' : 'tracking';
}

/**
 * The person checks an 'action' ticket off themselves as they actually do
 * it in the real world — this never runs automatically. Flips status to
 * 'fulfilled' once every actionable ticket is complete.
 */
export async function toggleTicket(id: string, ticketIndex: number, done: boolean): Promise<Commitment | undefined> {
  const commitments = await readJson<Commitment[]>('commitments.json', []);
  const commitment = commitments.find((c) => c.id === id);
  const ticket = commitment?.plan.tickets[ticketIndex];
  if (!commitment || !ticket || ticket.kind !== 'action') return undefined;

  ticket.done = done;
  refreshStatus(commitment);

  await writeJson('commitments.json', commitments);
  return commitment;
}

/**
 * The person self-reports progress on a 'target' ticket (e.g. "I've
 * deposited $400 of $500") — this is never inferred or automated.
 */
export async function reportTicketProgress(
  id: string,
  ticketIndex: number,
  currentAmount: number,
): Promise<Commitment | undefined> {
  const commitments = await readJson<Commitment[]>('commitments.json', []);
  const commitment = commitments.find((c) => c.id === id);
  const ticket = commitment?.plan.tickets[ticketIndex];
  if (!commitment || !ticket || ticket.kind !== 'target') return undefined;

  ticket.currentAmount = Math.max(0, currentAmount);
  refreshStatus(commitment);

  await writeJson('commitments.json', commitments);
  return commitment;
}
