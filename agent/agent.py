"""Freebie Monitor tracking agent

    python agent.py                # with pre-configured questions
    python agent.py "question"     # ask one at a time
    python agent.py --chat         # interactive

Ported from https://github.com/sandhya-subramani/Agent-with-a-Brain (Cognee + Strands Agents),
same shape, personal-rewards-tracking domain instead of retail support. Read top to bottom:
  MEMORY    CogneeMemory: the rewards brain, plugged in as a Strands memory store
  TOOLS     find_deals, start_tracking (real Docker sandbox), apply_for_account (never runs)
  HOOK      AuditHook prints every tool call
  STEERING  NeverSignUp permanently blocks apply_for_account before it runs
"""

import asyncio
import re
import subprocess
import sys
from datetime import datetime, timedelta

import httpx
from strands import Agent, tool
from strands.hooks import AfterToolCallEvent, HookProvider, HookRegistry
from strands.memory import MemoryManager
from strands.memory.types import MemoryEntry, MemoryInjectionConfig
from strands.vended_plugins.steering import Guide, Proceed, SteeringHandler

import cache
import config


# ── MEMORY ─────────────────────────────────────────────────────────────────────────────
# Strands' MemoryManager works with any object that has `search` and `add`. Cognee's cloud
# add_text/cognify/search ("V1" verbs — still fully supported, see config.py) are exactly
# those two operations, called over HTTP against your tenant instead of a local graph.

class CogneeMemory:
    name = "rewards_brain"
    description = "Reward-program rules, this person's profile, and every deal they're tracking."
    max_search_results = 5
    writable = True
    extraction = None

    def __init__(self, dataset: str = config.COGNEE_DATASET):
        self.dataset = dataset
        self.headers = {"X-Api-Key": config.COGNEE_API_KEY, "Content-Type": "application/json"}

    async def search(self, query, options=None):
        print(f"\n   [memory] cognee.search({query!r})")
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                res = await client.post(
                    f"{config.COGNEE_API_URL}/api/v1/search",
                    headers=self.headers,
                    json={"searchType": "GRAPH_COMPLETION", "query": query, "datasets": [self.dataset]},
                )
            if res.status_code != 200:
                return []
            return [
                MemoryEntry(content=str(r.get("search_result", "")))
                for r in res.json()
                if r.get("search_result")
            ]
        except Exception as e:
            print(f"   [memory] search failed, continuing without recall: {e}")
            return []

    async def add(self, content, metadata=None):
        print(f"\n   [memory] cognee.add({content!r})")
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                await client.post(
                    f"{config.COGNEE_API_URL}/api/v1/add_text",
                    headers=self.headers,
                    json={"textData": [content], "datasetName": self.dataset},
                )
                await client.post(
                    f"{config.COGNEE_API_URL}/api/v1/cognify",
                    headers=self.headers,
                    json={"datasets": [self.dataset], "runInBackground": False},
                )
        except Exception as e:
            print(f"   [memory] write failed, continuing: {e}")


def show_injection(ctx) -> str:
    print(f"   [memory] {len(ctx.entries)} entr{'y' if len(ctx.entries) == 1 else 'ies'} injected into the prompt")
    return "<rewards_brain>\n" + "\n".join(e.content for e in ctx.entries) + "\n</rewards_brain>"


# ── TOOLS ──────────────────────────────────────────────────────────────────────────────
# Tools know nothing about policy; the brain supplies that. Deal facts (dollar figures,
# eligibility rules, deadlines) live here in Python and are never retyped by the model —
# see report_progress's docstring for why that matters with this model.

# Set by ask()/main() right before each turn, straight from the person's raw input — never
# touched by the model. report_progress reads dollar amounts from here, not a tool argument.
_last_user_message = ""

DEALS = {
    "citi-checking-300": {
        "institution": "Citi",
        "title": "Citi Priority Checking — new account bonus",
        "value_usd": 300,
        "offer_expires_days": 90,  # the OFFER itself is only open this long — separate from the requirement window
        "qualified_deposit": "New-to-Citi money from an EXTERNAL bank only. Moving funds between your own "
        "existing Citi accounts does not count, even if the total hits $15,000.",
        "deposit_target_usd": 15000,
        "deposit_window_days": 20,
        "maintenance_period_days": 60,
        "eligibility": [
            "Not eligible if you've held a Citi checking account in the past 18 months.",
            "Not available to residents of CT or TX — Citi restricts this offer by state.",
        ],
    },
    "csp-60k": {
        "institution": "Chase",
        "title": "Chase Sapphire Preferred — sign-up bonus",
        "value_usd": 750,
        "offer_expires_days": 60,
        "qualified_deposit": None,
        "deposit_target_usd": 4000,
        "deposit_window_days": 90,
        "maintenance_period_days": 0,
        "eligibility": [
            "Chase's 5/24 rule: not eligible if you've opened 5+ personal credit cards (any bank) in the past 24 months.",
            "Once-per-family rule: no bonus if you've had a Sapphire-family card before, even years ago.",
        ],
    },
    "wells-fargo-100k": {
        "institution": "Wells Fargo Premier",
        "title": "Wells Fargo Premier Checking — relationship bonus",
        "value_usd": 2000,
        "offer_expires_days": 45,
        "qualified_deposit": "Combined balance across ALL linked Wells Fargo accounts (checking, savings, "
        "CDs) counts — but must be genuinely new funds, not an internal transfer from an existing WF account.",
        "deposit_target_usd": 100000,
        "deposit_window_days": 30,
        "maintenance_period_days": 90,
        "eligibility": [
            "Not eligible if you've received a Wells Fargo checking bonus in the past 12 months.",
        ],
    },
    "lowes-store-card": {
        "institution": "Lowe's",
        "title": "Lowe's Advantage Card — new cardholder discount",
        "value_usd": 100,
        "offer_expires_days": 365,
        "qualified_deposit": None,
        "deposit_target_usd": None,
        "deposit_window_days": 30,
        "maintenance_period_days": 0,
        "eligibility": [
            "Subject to credit approval — a hard credit inquiry will show on your report.",
        ],
    },
}


# Deals find_deals() discovers live that aren't in our richly-modeled DEALS dict —
# start_tracking looks here too, with a thinner (but honest) ticket set for these.
_live_deals: dict[str, dict] = {}


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "deal"


def _parse_usd(text: str) -> int:
    m = re.search(r"\$([\d,]+)", text or "")
    if m:
        return int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s*(points|miles)", text or "", re.I)
    if m:
        return round(int(m.group(1).replace(",", "")) * 0.01)
    return 0


@tool
async def find_deals() -> str:
    """List reward offers currently available, searched live from the web via Bright Data,
    enriched with real eligibility rules and qualified-deposit definitions where we have them.
    Check ALL of this against the person's situation, not just the headline dollar value.

    The search is fetched once and cached (cache.py) — repeated calls, even in a later run,
    reuse the cached page and extracted list rather than re-searching or re-running inference.
    """
    query = "best credit card and bank account sign-up bonuses this month 2026"
    page = await cache.fetch_page_cached(query)

    live_items = []
    if page:
        extracted = await cache.extract_json_cached(
            page,
            instruction=(
                "Extract current credit card / bank account sign-up bonus offers from this "
                'page. Reply as a JSON array: [{"institution": string, "title": string, '
                '"headline_value": string, "requirement": string}]. Only include real offers '
                "actually named on the page, not examples or unrelated ads."
            ),
            cache_key=f"deals:{query}",
        )
        if isinstance(extracted, list):
            live_items = extracted

    results = []
    matched_ids = set()

    for item in live_items:
        if not isinstance(item, dict) or not item.get("institution"):
            continue
        institution = str(item["institution"])
        match_id = next(
            (d_id for d_id, d in DEALS.items() if d["institution"].lower() in institution.lower()
             or institution.lower() in d["institution"].lower()),
            None,
        )
        if match_id:
            if match_id not in matched_ids:
                results.append({"id": match_id, "source": "live+known", **DEALS[match_id]})
                matched_ids.add(match_id)
            continue

        deal_id = _slugify(f"{institution}-{item.get('title', '')}")
        live_deal = {
            "institution": institution,
            "title": item.get("title") or institution,
            "value_usd": _parse_usd(item.get("headline_value", "")),
            "headline_value": item.get("headline_value", ""),
            "requirement": item.get("requirement", ""),
            "eligibility": [],
            "qualified_deposit": None,
            "deposit_target_usd": None,
            "deposit_window_days": 30,
            "maintenance_period_days": 0,
            "offer_expires_days": 60,
        }
        _live_deals[deal_id] = live_deal
        results.append({"id": deal_id, "source": "live", **live_deal})

    # Our fully-modeled deals are real offers too — always include whichever of them this
    # particular search didn't happen to surface, so eligibility data is never lost.
    for d_id, d in DEALS.items():
        if d_id not in matched_ids:
            results.append({"id": d_id, "source": "known", **d})

    return str(results)


def _addr_days(days: int) -> str:
    return (datetime.now() + timedelta(days=days)).date().isoformat()


@tool
def start_tracking(deal_id: str) -> str:
    """Start tracking a deal the PERSON has decided to pursue themselves, AFTER you've walked
    them through its eligibility rules and they've confirmed they qualify. Builds the full
    ticket set (eligibility confirmations, the qualified-deposit definition, the deposit target,
    the maintenance window, and the offer's own expiration) from the deal's real data — you do
    not supply any of these values yourself, only the deal_id, so nothing gets retyped or
    approximated. Runs in an isolated, network-less Docker sandbox and does not sign anyone up
    for anything — it only sets up tracking for a deal the human is going to go do on their own.

    Args:
        deal_id: The deal id, e.g. citi-checking-300.
    """
    deal = DEALS.get(deal_id)
    if not deal:
        return f"Unknown deal_id {deal_id!r}. Call find_deals first."

    tickets = [f"[eligibility] Confirm: {rule}" for rule in deal["eligibility"]]
    if deal["qualified_deposit"]:
        tickets.append(f"[qualified deposit] Understand: {deal['qualified_deposit']}")
    tickets.append(f"[action] Open the {deal['title']} account — offer expires {_addr_days(deal['offer_expires_days'])}")
    if deal["deposit_target_usd"]:
        tickets.append(
            f"[target ${deal['deposit_target_usd']:,}] Deposit qualified funds — "
            f"due {_addr_days(deal['deposit_window_days'])}"
        )
    if deal["maintenance_period_days"]:
        maintain_by = deal["deposit_window_days"] + deal["maintenance_period_days"]
        tickets.append(f"[action] Maintain the balance without dropping below the minimum — until {_addr_days(maintain_by)}")

    script = "; ".join(
        [
            f"echo '[actor] tracking initialized for {deal['institution']} ({deal_id})'",
            "echo '[actor] this does not sign anyone up for anything'",
            *[f"echo '[actor] ticket: {t}'" for t in tickets],
        ]
    )
    try:
        result = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "busybox", "sh", "-c", script],
            capture_output=True, text=True, timeout=15,
        )
        log = result.stdout.strip() or result.stderr.strip()
    except Exception as e:
        log = f"(sandbox unavailable: {e})"

    return f"Tracking {deal['title']} (worth ${deal['value_usd']:,}). Tickets:\n" + "\n".join(tickets) + f"\n\n{log}"


@tool
async def check_company_standing(institution: str) -> str:
    """Check for recent class-action lawsuits, settlements, or regulatory actions against a
    bank/card issuer — relevant because an active settlement can make someone ineligible for a
    new bonus if they were already a class member, or signal the offer carries more risk than
    the headline number suggests. Always mention what you find, even briefly.

    The underlying web page is fetched once per institution and cached (cache.py) — re-checking
    the same institution, even in a later run, reuses the cached page AND the cached answer
    rather than re-fetching or re-running inference. Runs as its own small, single-purpose
    extraction pass over the cached page, not inline in this conversation, so a noisy search
    results page never lands in the main agent's context.

    Args:
        institution: The bank/card issuer name, e.g. "Citi".
    """
    query = f"{institution} class action lawsuit settlement 2026"
    page = await cache.fetch_page_cached(query)
    if not page:
        return "(Bright Data not configured or lookup failed — skipping live check)"
    return await cache.extract_cached(
        page,
        question=f"Is there an active or recent class-action lawsuit, settlement, or regulatory "
        f"action against {institution}? Name it briefly if so.",
        cache_key=f"standing:{institution}",
    )


@tool
async def report_progress(deal_id: str) -> str:
    """Record progress the person just reported toward a deal's deposit/spend requirement.
    Call this whenever their message mentions a dollar amount they've put toward tracking a
    deal — you don't supply the amount; it's read directly from their raw message text in code.
    This model has been observed regenerating (not literally copying) numbers it passes through
    tool arguments, even when told to quote verbatim, dropping digits in the process (writing "4"
    for "400"). The only reliable fix is removing the model from that path entirely: this tool
    takes no amount argument, so there's nothing left for it to retype.

    Args:
        deal_id: The deal id, e.g. citi-checking-300.
    """
    match = re.search(r"\$?\s?([0-9][0-9,]*(?:\.[0-9]+)?)", _last_user_message)
    if not match:
        return f"Couldn't find a dollar amount in the person's last message — ask them to restate it with a number."
    amount = float(match.group(1).replace(",", ""))
    fact = f"Deal {deal_id}: progress update, ${amount:,.0f} recorded toward the requirement."
    await CogneeMemory().add(fact)
    return f"Recorded ${amount:,.0f} toward {deal_id}."


@tool
def apply_for_account(deal_id: str, institution: str) -> str:
    """Open an account or sign up for a reward offer on the person's behalf.

    Args:
        deal_id: The deal id.
        institution: The bank/card issuer name.
    """
    # Never actually reached — NeverSignUp steering blocks every call before it runs.
    return f"Applied for {institution} ({deal_id})."


# ── HOOK ───────────────────────────────────────────────────────────────────────────────
# Deterministic code in the agent loop. Runs after every tool call, always.

class AuditHook(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self.after_tool)

    def after_tool(self, event: AfterToolCallEvent) -> None:
        status = event.result.get("status", "?") if event.result else "cancelled"
        print(f"   [hook] {event.tool_use['name']}({event.tool_use.get('input', {})}) -> {status}")


# ── STEERING ───────────────────────────────────────────────────────────────────────────
# Policy that runs BEFORE a tool executes and can redirect the model. No LLM involved.
# Unlike the original starter's threshold-based RefundApproval, this blocks unconditionally —
# the agent tracks reward opportunities, it never signs anyone up for anything, period.

class NeverSignUp(SteeringHandler):
    def __init__(self):
        super().__init__(context_providers=[])

    async def steer_before_tool(self, *, agent, tool_use, **kwargs):
        if tool_use["name"] == "apply_for_account":
            print("\n   [steering] BLOCKED apply_for_account: the agent never signs up for anything")
            return Guide(
                reason="Hard rule: this agent never opens accounts or signs up for anything on the "
                "person's behalf, no matter how sure it is. Instead, tell the person exactly what to "
                "go do themselves (which account, what the requirement is, and the deadline), call "
                "start_tracking once they've said they're going to pursue it, and remind them to "
                "report progress back so you can track it."
            )
        return Proceed(reason="ok")


# ── THE AGENT ──────────────────────────────────────────────────────────────────────────

agent = Agent(
    model=config.get_model(),
    tools=[find_deals, start_tracking, report_progress, check_company_standing, apply_for_account],
    hooks=[AuditHook()],
    plugins=[NeverSignUp()],
    memory_manager=MemoryManager(
        stores=[CogneeMemory()],
        add_tool_config=True,                                     # agent may save new facts
        injection=MemoryInjectionConfig(format=show_injection),   # recall before every turn
    ),
    system_prompt=(
        "You are Freebie Monitor, a personal rewards-tracking agent. You are not a listing site — "
        "every deal has real eligibility rules and a real qualified-deposit definition, and your "
        "job is to make sure the person actually engages with them, not just see a dollar figure. "
        "Facts inside <rewards_brain> are this person's known profile and progress; they are "
        "authoritative — use them and be specific. Call find_deals to see what's currently "
        "available, then reason about fit using the brain, citing the specific fact that makes a "
        "deal worth it or not. Never recommend a deal that needs a new account to someone who said "
        "they don't want new accounts. Before you call start_tracking for a deal, walk the person "
        "through its eligibility list from find_deals and its qualified-deposit definition (if any) "
        "one at a time, and get an explicit answer for each — do not assume they qualify just "
        "because they didn't object. If any eligibility rule sounds like it might apply against "
        "them, say so plainly and ask them to confirm before proceeding. For a bank or card issuer "
        "you haven't already checked this conversation, call check_company_standing once before "
        "recommending it, and mention anything material you find. "
        "You NEVER open accounts or sign up for anything yourself — do not call apply_for_account. "
        "start_tracking only needs the deal_id; it builds the real ticket list (eligibility "
        "confirmations, the deposit target, the maintenance window, the offer's own expiration) "
        "from the deal's actual data itself, so don't invent or retype any numbers into it. "
        "When the person reports a dollar amount they've deposited or spent toward a deal, call "
        "report_progress with just that deal's id — it reads the actual number from their message "
        "itself, you don't and shouldn't pass it. Use add_memory only for non-dollar facts. "
        "Be concise: a few lines, no preamble."
    ),
)

DEMO = [
    "I own a home, fly a few times a year, have $50k+ sitting idle, shop at big-box stores, and want cashback. What's worth my time?",
    "Great, sign me up for the Citi one.",
    "OK, I opened it myself and I've deposited $400 toward the Citi bonus so far. Remember that.",
    "How much more do I need to deposit for the Citi bonus, and by when?",
]


async def ask(text: str) -> None:
    global _last_user_message
    _last_user_message = text
    print(f"\n{'─' * 78}\n>>> {text}\n")
    await agent.invoke_async(text)


async def main(argv: list[str]) -> None:
    if argv == ["--chat"]:
        while (q := input("\nyou> ").strip()) not in {"", "exit", "quit"}:
            await ask(q)
    elif argv:
        await ask(" ".join(argv))
    else:
        for q in DEMO:
            await ask(q)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
