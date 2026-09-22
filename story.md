## Inspiration

Credit card, bank, and store sign-up bonuses are effectively free money — but the rules that
gate them are genuinely hostile: minimum-deposit windows, maintenance periods, once-per-family
restrictions, state exclusions, "new customer only" clauses. Miss one deadline and you forfeit
the whole bonus, no partial credit. That's a rules-and-memory problem, not a chatbot problem —
exactly what Cognee (persistent memory) and Strands Agents (reasoning + tools) are for. We
built Freebie Monitor: an agent that remembers your situation, finds offers that actually fit
it, and tracks the real deadlines — without ever pretending it can sign up for anything on
your behalf.

## What it does

You tell it about yourself once — homeowner, travel habits, idle cash, whether you're open to
new accounts. It searches current reward offers, checks each one against your specific
situation (citing the exact fact that makes it worth it or not), and flags real eligibility
rules before you commit: qualified-deposit definitions, geo-restrictions, once-per-X-months
exclusions. If you decide to pursue one, it builds a calendar of real tickets — open the
account, hit the deposit target, maintain the balance, don't miss the offer's own expiration —
and you check them off or self-report progress as you go. It never opens an account or signs
up for anything itself; that's a hard rule enforced in code, not just a prompt. It also checks
for open class-action activity against an issuer before recommending it, because an existing
settlement can make you ineligible for a new bonus.

## How we built it

Cognee (its cloud API's add/cognify/search) holds the person's profile and every commitment as
a real knowledge graph, injected into the agent's context before each turn via Strands'
MemoryManager. Strands Agents does the reasoning and orchestrates a small tool set: find
deals, check a company's legal standing, start tracking something, and (deliberately) an
apply_for_account tool that a Strands steering handler blocks unconditionally, before it ever
executes — no LLM judgment call involved, a hard guarantee the agent can't be talked into
signing anyone up for anything. Bright Data powers live deal discovery and the class-action
check, through a fetch-once/extract-many cache: a page is scraped once, then a small focused
extraction pass (not the main conversational agent) turns it into structured facts, so re-
asking the same question never re-scrapes or re-runs inference. We started this as a polished
web app, then rebuilt the agent core in Python to match the hackathon's required starting
point (a Cognee + Strands memory-store pattern), keeping the same MemoryManager/hook/steering
shape while pointing it at infrastructure we could actually get working under time pressure.

## Challenges we ran into

Nearly every integration had a real, undocumented bug we had to find by testing, not reading
docs. Streaming tool-calls broke in opposite ways on different providers: Bedrock's streaming
path fragmented tool calls into dozens of empty pieces (fixed with `streaming=False`), while
our local model fallback hit the *opposite* bug — `streaming=False` crashed a completely
different way, a real Strands SDK bug where a non-streaming reply gets re-synthesized into
delta events and leaks a raw int into a field the accumulator assumes is always a string. Small
models turned out to be fundamentally unreliable at literally copying numbers through tool-call
arguments, even when explicitly told to quote a user verbatim — they'd regenerate "$400" as
"$4." The only real fix was removing the model from that path entirely: read the raw dollar
figure directly from the person's own message text in code, never let the model retype it. We
also hit Bright Data returning HTTP 200 with an empty body intermittently, solved with retries;
an unencoded-space bug in our own query URLs; and an AWS Bedrock account that needed a one-time
manual "use case" form submitted in the console before it could invoke any model at all, mid-
build. We also had an honest self-correction: we'd wired Docker into the "start tracking" step
mostly to check a sponsor-requirement box, running a fixed script that added no real isolation
value for what is fundamentally calendar-and-reminder logic — worth admitting rather than
dressing up as more than it was.

## Accomplishments that we're proud of

Every sponsor integration is real and independently verified, not just wired up and hoped for:
we captured raw HTTP responses proving Cognee's cloud graph, Bright Data's live scrapes, and
the model calls all genuinely execute. The steering block was verified directly, not just
assumed — we called the handler with a synthetic `apply_for_account` request and confirmed it
returns `Guide` (blocked) every time, independent of what the model decides to do, which is the
actual safety property that matters. And when the agent's own memory got corrupted by a model
retyping bug, it caught the inconsistency itself, told the user plainly ("this is on me, not
you"), and cross-checked the authoritative deal data to give the right answer anyway instead of
confidently repeating a wrong number.

## What we learned

Small local models cannot be trusted to relay structured or numeric data through tool-call
arguments — the fix is architectural, not prompt-engineering: keep structured data ownership in
code, and only ever ask the model for the smallest possible piece of free text. Streaming
behavior is provider-specific and has to be empirically verified per provider, never assumed
from one working example. And "matching a required starting point" is about matching its
integration *pattern* (the same MemoryManager/hook/steering shape) — not necessarily its exact
infrastructure choices, when time pressure means the exact choices aren't available to you.

## What's next for Freebie Monitor

Real calendar export (.ics) and email/SMS reminders — right now the nagging is in-app only.
Dedupe protection so tracking the same deal twice doesn't create duplicate records. Full live
Bright Data discovery replacing the last of our seed data, with richer eligibility extraction
(state restrictions, once-per-family rules) sourced from real issuer terms pages instead of
hand-modeled. Bedrock as the primary model once the account's use-case review clears, since a
larger model should eliminate the number-retyping failure mode we had to design around. And a
proper reconciliation between the original web UI and this agent core, so the two aren't
running as separate demos.
