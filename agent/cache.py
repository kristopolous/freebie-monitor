"""Fetch-once, extract-many caching for anything sourced from the live web.

Two tiers, both on disk under .cache/ so they survive between runs:
- raw pages, keyed by the fetch query/URL — a Bright Data call never repeats for the
  same query.
- extracted answers, keyed by (page, specific question) — a focused extraction pass
  never repeats for a question already answered against that page.

This is deliberately NOT the same as handing raw page content to the main conversational
agent and asking it to reason about everything else at the same time: extraction runs as
its own small, single-purpose inference call over just that page, so the main agent only
ever sees a short distilled answer, not noisy HTML it has to also make sense of live.
"""

import hashlib
import json
import re

import config

CACHE_DIR = config.ROOT / ".cache"


def _slug(key: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "_", key)[:80]
    digest = hashlib.sha1(key.encode()).hexdigest()[:8]
    return f"{safe}_{digest}"


def get(key: str) -> str | None:
    path = CACHE_DIR / f"{_slug(key)}.txt"
    return path.read_text() if path.exists() else None


def set(key: str, value: str) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    (CACHE_DIR / f"{_slug(key)}.txt").write_text(value)


async def fetch_page_cached(query: str) -> str:
    """Bright Data raw fetch, cached by query. Returns "" if unconfigured/failed —
    callers treat that as "no source available", not an error to surface loudly."""
    import os
    import urllib.parse

    import httpx

    cached = get(f"raw:{query}")
    if cached is not None:
        return cached

    api_key = os.environ.get("BRIGHTDATA_API_KEY")
    if not api_key:
        set(f"raw:{query}", "")
        return ""

    zone = os.environ.get("BRIGHTDATA_ZONE", "mcp_unlocker")
    search_url = f"https://www.google.com/search?q={urllib.parse.quote(query)}"

    # Bright Data has been observed returning 200 with an EMPTY body intermittently
    # (confirmed: identical request failed empty, then succeeded with real content on
    # retry) — a couple of retries is worth it since a successful fetch gets cached
    # and never re-paid for.
    text = ""
    for attempt in range(3):
        try:
            # Real anti-bot unlocking overhead, verified 10-20s+ per request in prior
            # testing — generous timeout matters more than speed, this is cached after.
            async with httpx.AsyncClient(timeout=45) as client:
                res = await client.post(
                    "https://api.brightdata.com/request",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={"zone": zone, "url": search_url, "format": "raw"},
                )
            if res.status_code == 200 and res.text.strip():
                text = res.text[:8000]
                break
            print(f"   [cache] Bright Data attempt {attempt + 1}: status={res.status_code} len={len(res.text)}")
        except Exception as e:
            print(f"   [cache] Bright Data attempt {attempt + 1} raised: {e!r}")

    set(f"raw:{query}", text)
    return text


async def extract_cached(page: str, question: str, cache_key: str) -> str:
    """One small, focused inference pass over already-fetched content. `cache_key`
    should uniquely identify (page, question) — e.g. "standing:Citi" — so re-asking
    the same question about the same source never re-runs inference."""
    cached = get(f"extract:{cache_key}")
    if cached is not None:
        return cached

    if not page.strip():
        answer = "(no source page available)"
        set(f"extract:{cache_key}", answer)
        return answer

    from strands import Agent

    extractor = Agent(
        model=config.get_model(),
        system_prompt=(
            "Answer ONLY using the page content you're given, in 1-2 plain sentences. "
            "If the answer isn't in the content, say exactly 'nothing found'. No preamble, "
            "no markdown, no hedging."
        ),
    )
    result = await extractor.invoke_async(f"Page content:\n{page[:6000]}\n\nQuestion: {question}")
    answer = str(result).strip()
    set(f"extract:{cache_key}", answer)
    return answer


async def extract_json_cached(page: str, instruction: str, cache_key: str):
    """Like extract_cached, but asks for and parses JSON. Returns None on failure/no source
    so callers fall back gracefully. Uses plain-text generation (not tool-calling) for the
    JSON — this model has been unreliable relaying structured data through tool-call
    arguments, but asking it to just write JSON in its reply works fine."""
    cached = get(f"extractjson:{cache_key}")
    if cached is not None:
        try:
            return json.loads(cached)
        except Exception:
            return None

    if not page.strip():
        return None

    from strands import Agent

    extractor = Agent(
        model=config.get_model(),
        system_prompt=(
            "Extract structured data from the page content you're given. Reply with ONLY raw "
            "JSON matching the requested shape — no markdown fences, no commentary, no preamble. "
            "If nothing matches, reply with an empty JSON array []."
        ),
    )
    result = await extractor.invoke_async(f"Page content:\n{page[:6000]}\n\n{instruction}")
    raw = str(result).strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"```\s*$", "", raw)
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    set(f"extractjson:{cache_key}", json.dumps(parsed))
    return parsed
