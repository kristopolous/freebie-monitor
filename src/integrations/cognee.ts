import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout } from './fetchTimeout.js';

const COGNEE_TIMEOUT_MS = 20_000;

// The "brain": a per-profile fact graph. Real mode calls Cognee Cloud's
// add / cognify / search verbs (https://docs.cognee.ai) so the personal
// context — home ownership, travel habits, idle cash, past commitments —
// is genuinely reasoned over via Cognee, not just string-matched.
//
// Until COGNEE_API_KEY is set, this falls back to a local JSON-backed
// fact store with the exact same shape, so the rest of the app never
// needs to know which mode it's in.

export interface CogneeClient {
  mode: 'live' | 'local';
  addFacts(datasetId: string, facts: string[]): Promise<void>;
  cognify(datasetId: string): Promise<void>;
  search(datasetId: string, query: string): Promise<string[]>;
  allFacts(datasetId: string): Promise<string[]>;
}

function isLive(): boolean {
  return Boolean(process.env.COGNEE_API_KEY);
}

class LiveCogneeClient implements CogneeClient {
  mode = 'live' as const;
  // Tenant is implied by the subdomain — the tenant-specific API base URL
  // from the platform's API Keys page, not the shared api.aws.cognee.ai host.
  private baseUrl = process.env.COGNEE_API_URL || 'https://api.cognee.ai';
  private headers = {
    'X-Api-Key': process.env.COGNEE_API_KEY ?? '',
    'Content-Type': 'application/json',
  };

  async addFacts(datasetId: string, facts: string[]): Promise<void> {
    // Write the local mirror first and unconditionally — allFacts() always
    // reads from it, so a slow/down remote must never cost us the facts
    // themselves, only the graph reasoning built on top of them.
    await localAddFacts(datasetId, facts);
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/add_text`,
        { method: 'POST', headers: this.headers, body: JSON.stringify({ textData: facts, datasetName: datasetId }) },
        COGNEE_TIMEOUT_MS,
      );
      if (!res.ok) console.warn(`[cognee] add_text failed: ${res.status} ${await res.text()}`);
    } catch (err) {
      console.warn('[cognee] add_text request failed, facts kept in local mirror only:', err);
    }
  }

  async cognify(datasetId: string): Promise<void> {
    // runInBackground: false — onboarding calls this right before the first
    // Matcher search() a moment later, so the graph needs to be ready by
    // the time this call returns, not still processing async. Non-fatal on
    // failure: search() already degrades to the local index on its own.
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/cognify`,
        { method: 'POST', headers: this.headers, body: JSON.stringify({ datasets: [datasetId], runInBackground: false }) },
        COGNEE_TIMEOUT_MS,
      );
      if (!res.ok) console.warn(`[cognee] cognify failed: ${res.status} ${await res.text()}`);
    } catch (err) {
      console.warn('[cognee] cognify request failed:', err);
    }
  }

  async search(datasetId: string, query: string): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/v1/search`,
        { method: 'POST', headers: this.headers, body: JSON.stringify({ searchType: 'GRAPH_COMPLETION', query, datasets: [datasetId] }) },
        COGNEE_TIMEOUT_MS,
      );
      if (!res.ok) return localSearch(datasetId, query);
      const results = (await res.json()) as Array<{ search_result: unknown }>;
      if (Array.isArray(results) && results.length > 0) {
        return results.map((r) => (typeof r.search_result === 'string' ? r.search_result : JSON.stringify(r.search_result)));
      }
      return localSearch(datasetId, query);
    } catch {
      // Timed out, aborted, or a network error — degrade to the local
      // index rather than break the demo mid-flow.
      return localSearch(datasetId, query);
    }
  }

  async allFacts(datasetId: string): Promise<string[]> {
    return localAllFacts(datasetId);
  }
}

// --- local fallback -------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), '.data', 'cognee');

async function factsFile(datasetId: string): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, `${datasetId}.json`);
}

async function localAllFacts(datasetId: string): Promise<string[]> {
  try {
    const raw = await readFile(await factsFile(datasetId), 'utf-8');
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function localAddFacts(datasetId: string, facts: string[]): Promise<void> {
  const existing = await localAllFacts(datasetId);
  const merged = [...existing, ...facts];
  await writeFile(await factsFile(datasetId), JSON.stringify(merged, null, 2), 'utf-8');
}

async function localSearch(datasetId: string, query: string): Promise<string[]> {
  const facts = await localAllFacts(datasetId);
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return facts
    .map((fact) => {
      const lower = fact.toLowerCase();
      const hits = terms.filter((t) => lower.includes(t)).length;
      return { fact, hits };
    })
    .filter((f) => f.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((f) => f.fact);
}

class LocalCogneeClient implements CogneeClient {
  mode = 'local' as const;
  async addFacts(datasetId: string, facts: string[]): Promise<void> {
    await localAddFacts(datasetId, facts);
  }
  async cognify(): Promise<void> {
    // No-op locally — facts are already flat and searchable.
  }
  async search(datasetId: string, query: string): Promise<string[]> {
    return localSearch(datasetId, query);
  }
  async allFacts(datasetId: string): Promise<string[]> {
    return localAllFacts(datasetId);
  }
}

let cached: CogneeClient | undefined;

export function getCogneeClient(): CogneeClient {
  if (!cached) cached = isLive() ? new LiveCogneeClient() : new LocalCogneeClient();
  return cached;
}
