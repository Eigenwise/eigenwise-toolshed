---
name: pick-model
description: >-
  Suggest which model to use for a task, and what each available model is actually good at. Use when
  choosing or comparing models, deciding what to route work to, or asking which model fits a job.
---

# Pick a model

What each model reachable from this machine is actually good for, so you can **suggest** a model to
the user with a reason. The user picks. Do not silently route everything to the most expensive
thing available.

**Researched 2026-08-02.** Model facts rot fast. Prices, deprecations, and benchmark standings all
move within weeks. If something here contradicts what the vendor's docs say today, the docs win, and
this file needs a refresh. Sourcing is marked `[vendor]` or `[independent]` throughout, and gaps are
marked unmeasured rather than filled in with a guess.

## Start here

| The task | Suggest | Why |
|---|---|---|
| Everyday coding, clear destination | Sonnet 5, or Codex Terra | Both sit near the flagship on real coding work at a fraction of the cost |
| Hard coding, approach genuinely unknown | Opus 5 | Leads bug and performance investigation; best value at the top |
| Hard *and* long, where the decisions keep coming | Fable 5 | Sustained difficulty is where its thin edge compounds |
| Long but mechanical, a big repetitive sweep | Haiku 4.5, Luna, or Sonnet 5 | Length alone is no reason to pay more |
| Bulk classify, extract, transform | Haiku 4.5, or Codex Luna | Execution-only work, no judgment needed |
| Fast mechanical edits where latency beats polish | Codex Luna | Cheap and quick, weak on long autonomous runs |
| Long-context reading, one big corpus | Opus 5 or Sonnet 5 (1M) | Real 1M windows; see the context trap below |
| Cheap iteration a human will review anyway | Grok 4.5 | Fast and cheap, hallucinates more; fine with a human in the loop |
| Anything high-stakes or unreviewed | Opus 5 | Reliability is the whole point of the spend |

**The default is not the flagship.** Most work belongs on Sonnet 5 or Terra. Reach up when the task
is genuinely hard or the cost of being wrong is high, not because the task looks big.

## Anthropic

### Opus 5 (`claude-opus-5`) — $5 / $25 per 1M, 1M context

The best value at the top of the range. Narrowly #1 on Artificial Analysis' Intelligence Index (61
at max effort), tied with Fable 5 while costing about 26% less per task `[independent]`. Leads
agentic knowledge work by a wide margin and topped the "bug and performance investigation" category
on Senior SWE-bench. Reach for it on hard debugging, long-horizon agentic coding, and anything
where a wrong answer is expensive.

Two real caveats:

- **Hallucination went up.** Accuracy improved by answering more when uncertain, and the measured
  hallucination rate rose 14 points to 50% versus Opus 4.8 `[independent]`. It guesses rather than
  says it doesn't know.
- **Effort is not monotonic.** Anthropic's own data shows Frontier-code performance peaking around
  *medium* effort and getting both worse and pricier above it, apparently from overthinking
  `[vendor]`. Independent testing found high most consistent. Do not reflexively pin it to max.

### Sonnet 5 (`claude-sonnet-5`) — $2 / $10 per 1M through 2026-08-31, then $3 / $15, 1M context

The right default for most coding. Beat Opus 4.8 on Terminal-Bench 2.1 (80.4% vs 74.6%) `[vendor]`
and edged Opus 4.8 on agentic knowledge work, the first time a Sonnet has passed the concurrent
Opus flagship on anything `[independent]`. Where it still loses is hard software engineering:
SWE-bench Pro 63.2% vs Opus 5-class 69%+, a real gap, not noise.

**The cost inversion is the thing to know.** At max effort it burns roughly 40% more output tokens
than Sonnet 4.6 and up to 3x the agentic turns, which makes it about 15% *more expensive per task
than Opus 5* despite the lower headline rate `[independent]`. Low and medium stay cheap. If you find
yourself wanting Sonnet 5 at max effort, you probably want Opus 5 at medium instead.

Medium effort is positioned as comparable to Sonnet 4.6 at high, so it's a genuine step-down for
routine work.

### Fable 5 (`claude-fable-5`) — $10 / $50 per 1M, 1M context

Twice Opus 5's price. What it buys is genuinely thin and pulls in two directions: Fable leads
SWE-bench Pro, the hardest non-saturated software engineering benchmark (80.0% vs 79.2%), while Opus
5 is *ahead* of it on the general Intelligence Index (61 vs 60) `[independent]`. A one-point lead on
one benchmark is not a capability tier. Anthropic separately positions it for the longest autonomous
runs, on multi-day horizons `[vendor]`.

**Length and difficulty are different axes, and only one of them justifies the price.** A long
mechanical sweep across 400 files is long and easy; it wants a cheap model and good scoping, not
Fable. A hard problem you can state in a paragraph is short and hard; Opus 5 solves it for half the
money. What plausibly earns the premium is the overlap, where hard decisions keep arriving over a
long horizon and small per-step quality gaps compound into a wrong architecture by hour six. That is
also the case nobody has cleanly benchmarked, so treat it as reasoning from the shape of the task,
not a measured result.

**Do not treat it as a default upgrade.** If you are about to suggest Fable for ordinary work, the
honest recommendation is Opus 5 at half the cost.

Two quirks worth knowing: it silently reroutes some cybersecurity, biology, chemistry, and
distillation queries to Opus 4.8 in under 5% of sessions `[vendor]`, which looks like an unexplained
model swap if you don't expect it. And it was pulled globally for three weeks in June 2026 over
export controls, so its availability carries more risk than the standard line.

### Haiku 4.5 (`claude-haiku-4-5`) — $1 / $5 per 1M, 200K context

The only one here without a 1M window, and its knowledge cutoff (July 2025) is a year staler than
Sonnet 5's. Built for volume: classification, extraction, routing, bounded tool calls, and parallel
worker agents under a smarter planner. Independently measured at roughly 90% of Sonnet 4.5's
agentic coding performance for about a third of the cost `[independent]`, which is a strong trade
for bounded subtasks.

Wrong pick for complex reasoning, planning, or math. Computer use succeeds only 50.7% of the time,
which the vendor itself calls not reliable enough to run unattended.

## OpenAI Codex

Sol, Terra, and Luna are OpenAI's own tier names for GPT-5.6, not a local invention. Tier and
reasoning effort are **independent knobs**: a high-effort Luna can beat a low-effort Terra
`[independent]`. Don't assume the tier alone decides quality.

- **Sol** — $5 / $30 per 1M. Flagship: complex coding, computer use, research, security work. Top
  of the Coding Agent Index within the family, and roughly tied with Opus 5 on agentic coding
  overall. Known failure mode: users report constraint drift over long sessions, where it loses
  instructions, apologizes, then repeats the same mistake class. Worth knowing before pointing it at
  an unattended overnight run.
- **Terra** — $2.50 / $15 per 1M. The everyday default and the sanctioned replacement for GPT-5.5 at
  lower cost. This is where most Codex-routed coding belongs.
- **Luna** — $1 / $6 per 1M. Fast and cheap: extraction, classification, transformation, small
  mechanical edits. Not for long autonomous runs.

Family-wide weak spots, all from independent reports rather than vendor copy: over-eager tool calls
that act beyond the ask despite explicit constraints, over-literal instruction following where
Claude infers intent better from terse prompts, and open tool-call format bugs (400s on unsupported
action types, empty function names from an SSE parsing bug on Azure-compatible providers).

### Deprecated, do not suggest

- `gpt-5.2`, `gpt-5.3-codex` — **already deprecated** for Codex with ChatGPT sign-in `[vendor]`.
- `gpt-5.4`, `gpt-5.4-mini` — **retire 2026-08-31**, migrating to Terra and Luna respectively.
- `gpt-5.5` — superseded by Terra at equal-or-better capability for less.
- `gpt-5.3-codex-spark` — a distilled 5.3 variant at >1000 tok/s, 128k context. Hands-on review found
  real quality loss versus full 5.3-codex. Only worth it when raw edit latency beats correctness.

These are still listed in this plugin's catalog (`lib/commands.js:822`). Six of the nine entries are
dead or dying; the catalog needs a cleanup pass.

## xAI Grok

Only `grok-4.5` is actually served through the CLI subscription today. The live model cache
(`~/.grok/models_cache.json`) lists it alone, at 500k context, with `agent_type: "grok-build-plan"`.

- **`grok-4.5`** — 500k context, reasoning, three effort levels. Genuinely fast and cheap: about
  $2.49 per task against $11.80 for a Claude Code Opus max-mode run, using roughly 4x fewer output
  tokens `[independent]`.
- **`grok-build`** — not separate weights. It's grok-4.5 running inside xAI's agentic coding
  harness, confirmed by the `grok-build-plan` agent type in the live cache.
- **`grok-4.3`, `grok-4.1-fast`** — not served. `grok-4.1-fast` is scheduled for full retirement on
  **2026-08-15** `[vendor]`. Both are still hardcoded in `lib/grok-backend.js:10`, which is stale.

**Where it honestly fits:** cheap, fast, low-stakes iteration that a human reviews. On neutral
benchmarks it trails both Opus 5 and Fable 5 on coding (DeepSWE 1.1: 53% vs 70%; SWE-bench Pro:
64.7% vs 80.4%) and only leads on xAI's own harness numbers `[independent]`. The speed comes with a
reported hallucination rate near 54%. Its one genuine differentiator is live X/social grounding,
which is data access rather than reasoning, and it skews toward loud accounts over expert sources.

Not a reliability pick. Don't suggest it for anything running unattended.

## Traps

**The context window you get is not the one advertised.** Codex models advertise about 1.05M, this
gateway measured the real ceiling at 370k, and Claude Code hardwires a 200k display window for any
`claude-`prefixed id regardless of backend capacity (`lib/commands.js:829`). Proactive
auto-compaction is off for those sessions. Plan around 200k for Codex routes, not 1M.

**More effort is not more quality.** Verified non-monotonic for Opus 5 (peaks near medium on coding)
and cost-inverting for Sonnet 5 (above high it can cost more per task than Opus 5). Fable 5 and
Haiku 4.5 effort scaling is **unmeasured** independently. Pinning everything to high is a real
waste, not a safe default.

**Long is not the same as hard.** Size is the easiest property of a task to see, so it gets used as a
proxy for difficulty and routes big-but-boring work to expensive models. Ask what the task's hardest
*single decision* is. If the answer is "there isn't one, there are just four hundred of them", that
is a scoping and parallelism problem, not a model problem. The reverse holds too: a genuinely hard
problem can fit in one paragraph.

**Skip SWE-bench Verified.** Saturated across the top models at 95-97%. A point or two is noise.
Terminal-Bench, SWE-bench Pro, DeepSWE, and the agentic knowledge-work evals still separate them.

**Vendor benchmarks measure vendor harnesses.** Grok leads on xAI's harness and trails on neutral
ones. Artificial Analysis was OpenAI's pre-release eval partner for GPT-5.6, so its GPT numbers are
independent but not arms-length. Weight accordingly.

## How to suggest

- **Name a model, a reason, and the runner-up.** "Terra for this, it's ordinary refactor work.
  Opus 5 if the interface turns out to be contested."
- **Say what it costs** when suggesting something expensive. The user should know they're paying 2x
  for Fable before they say yes.
- **Split the work when the pieces differ.** A hard design piece and six mechanical edits are not
  one routing decision.
- **Flag it when a model is dying.** A suggestion that stops resolving in two weeks is a bad
  suggestion.
- **Say "unmeasured" out loud.** Half the interesting questions here have no independent answer yet,
  and a confident guess is worse than a gap.
