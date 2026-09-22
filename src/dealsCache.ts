import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PersonalizedDeal } from './types.js';

// Matching runs a real ~20-30s LLM call, plus a real paid Bright Data fetch
// underneath it — a cache miss isn't just a slow reload, it's a paid API
// call. Backed by disk (not just an in-memory Map) so a dev-server restart
// (tsx watch hot-reloading on a code change) or a real process restart
// doesn't silently drop it and force a live, billed re-scan.
// Sign-up bonuses and bank promos run for weeks, not minutes — realistically
// checking once a day is already more often than terms actually change. The
// manual Rescan button is there for anyone who wants a forced fresh pull
// sooner. Invalidated whenever the profile's answers change, since matching
// depends on them.
const TTL_MS = 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(process.cwd(), '.data', 'store');
const FILE = 'deals-cache.json';

type CacheEntry = { at: number; deals: PersonalizedDeal[] };

const cache = new Map<string, CacheEntry>();
let loaded = false;

async function loadFromDisk(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(path.join(DATA_DIR, FILE), 'utf-8');
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [profileId, entry] of Object.entries(obj)) cache.set(profileId, entry);
  } catch {
    // no cache file on disk yet — fine, starts empty
  }
}

async function persist(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, FILE), JSON.stringify(Object.fromEntries(cache), null, 2), 'utf-8');
}

export async function getCachedDeals(profileId: string): Promise<PersonalizedDeal[] | null> {
  await loadFromDisk();
  const entry = cache.get(profileId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(profileId);
    await persist();
    return null;
  }
  return entry.deals;
}

export async function setCachedDeals(profileId: string, deals: PersonalizedDeal[]): Promise<void> {
  cache.set(profileId, { at: Date.now(), deals });
  await persist();
}

export async function invalidateDeals(profileId: string): Promise<void> {
  cache.delete(profileId);
  await persist();
}
