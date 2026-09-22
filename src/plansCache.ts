import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionPlan } from './types.js';

// Strategist's plan generation is a real ~15-25s LLM call — clicking "I'm doing this" on the
// same deal shouldn't pay that every time. The ticket SHAPE for a given deal (what to do, in
// what order) is essentially deal-specific, not profile-specific, so this is keyed by dealId
// alone and shared across everyone tracking that deal — same tradeoff as dealsCache.ts.
// Deadlines are baked in as absolute dates at generation time, but every one of them is
// day-granularity on a 30-90+ day window (same reasoning as dealsCache.ts's TTL bump) — a plan
// pre-warmed at scan time and clicked hours later is still accurate to the day. A short TTL
// would defeat the whole point of pre-warming: it'd expire before someone finishes reading the
// deal and clicking "I'm doing this."
// Persisted to disk for the same reason as dealsCache.ts: a real, paid LLM call shouldn't be
// silently re-billed just because the dev server restarted.
const TTL_MS = 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(process.cwd(), '.data', 'store');
const FILE = 'plans-cache.json';

type CacheEntry = { at: number; plan: ExecutionPlan };

const cache = new Map<string, CacheEntry>();
let loaded = false;

async function loadFromDisk(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(path.join(DATA_DIR, FILE), 'utf-8');
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [dealId, entry] of Object.entries(obj)) cache.set(dealId, entry);
  } catch {
    // no cache file on disk yet — fine, starts empty
  }
}

async function persist(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, FILE), JSON.stringify(Object.fromEntries(cache), null, 2), 'utf-8');
}

export async function getCachedPlan(dealId: string): Promise<ExecutionPlan | null> {
  await loadFromDisk();
  const entry = cache.get(dealId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(dealId);
    await persist();
    return null;
  }
  return entry.plan;
}

export async function setCachedPlan(dealId: string, plan: ExecutionPlan): Promise<void> {
  cache.set(dealId, { at: Date.now(), plan });
  await persist();
}
