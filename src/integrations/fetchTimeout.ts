/**
 * fetch() with an upper bound. A stalled TCP connection (no error, no
 * response) otherwise hangs forever — every external call in this app
 * (Cognee, the local model, Bright Data) needs this, not just the ones
 * that happened to get it first.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
