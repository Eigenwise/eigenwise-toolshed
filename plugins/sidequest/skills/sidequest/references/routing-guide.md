# Routing guide: what Anthropic actually says about model and effort choice

This is the grounding for the complexity scale — Anthropic's own published guidance on which model
tier fits which work and how hard it should think, distilled with direct quotes and sources. Read it
when you're unsure how to score a task, when the user asks why something routed where it did, or when
the derived rung looks wrong to you.

The core idea: **you score a task by matching its SHAPE to Anthropic's own model positioning**, not by
judging how hard it feels in this particular repo. "Feels hard" is relative to the codebase; "a
multi-file feature with a contract several consumers must respect" is the same shape in any codebase.
That's what makes the scale absolute.

> Kept in lockstep with the switchboard copy (`plugins/switchboard/skills/switchboard/references/`), same as
> the ladder engine fork.

## The official model matrix

From Anthropic's [Choosing the right model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
and [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview):

| Tier | Official positioning | Official example use |
|---|---|---|
| **haiku** (Haiku 4.5) | "The fastest model with near-frontier intelligence" | "Real-time applications, high-volume intelligent processing, cost-sensitive deployments needing strong reasoning, **sub-agent tasks**" |
| **sonnet** (Sonnet 5) | "The best combination of speed and intelligence — frontier intelligence at scale, built for coding, agents, and enterprise workflows" | Code generation, agentic tool use, data analysis — Claude Code's alias docs call it the tier for "**daily coding tasks**" |
| **opus** (Opus 4.8) | "For **complex agentic coding** and enterprise work" | Multi-hour autonomous coding agents, large-scale refactoring, complex systems engineering |
| **fable** (Fable 5) | "Next-generation intelligence for long-running agents" — suited to tasks "**larger than a single sitting**" | Root-cause investigations, outage debugging, architecture decisions; "describe the outcome, not the steps... it verifies its own work with less prompting" |

Anthropic's default rule when unsure: "start with Claude Opus 4.8 for complex agentic coding and
enterprise work. For workloads that need the highest available capability, use Claude Fable 5."

Pricing per MTok (in/out): haiku $1/$5 · sonnet $3/$15 · opus $5/$25 · fable $10/$50. Haiku is also
the only tier without a 1M context window (200K) and without the effort parameter.

## Per-model effort guidance (it is genuinely per model)

Anthropic's [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort) and Claude
Code's [model configuration](https://code.claude.com/docs/en/model-config) give DIFFERENT advice per
tier — don't transfer one model's framing to another:

- **sonnet**: default `high`. "**xhigh effort: for the hardest coding and agentic tasks.**" `medium`
  is "comparable to Sonnet 4.6 at high effort"; `low` is for high-volume / latency-sensitive work.
- **opus**: default `high`, but for coding/agentic work the official starting point is `xhigh` —
  "start with xhigh for coding and agentic use cases... step down only when you've measured that the
  lower level holds quality."
- **fable**: default `high`, and explicitly NOT xhigh-first: "**Start with high, the default, for most
  tasks, use xhigh for the most capability-sensitive workloads... Lower effort settings on Claude
  Fable 5 still perform well and often exceed xhigh performance on prior models.**"
- **max** (any tier): "**Reserve max for genuinely frontier problems. On most workloads max adds
  significant cost for relatively small quality gains, and on some... tasks it can lead to
  overthinking.**" Claude Code's table adds: "prone to overthinking. Test before adopting broadly."
- **haiku**: no effort parameter at all — the supported-models list excludes it. Haiku's cost/speed
  lever is picking haiku itself.

And the line that justifies a merged model×effort ladder in the first place: "**Tuning effort is
often a better lever than switching models.**"

## Where haiku fits (and why sonnet·low doesn't replace it)

Researched 2026-07: haiku stays Pareto-optimal for the bottom rungs — Sonnet 5 at low effort does
not make it redundant.

- **Capability**: Haiku 4.5 scores 73.3% SWE-bench Verified; Anthropic says it "rivals the reasoning
  capabilities of our Sonnet 4.0 model". Enough for subagent-shaped work where the spec says
  everything.
- **Cost**: haiku is 3x cheaper on sticker ($1/$5 vs $3/$15), and the real gap is wider — Sonnet 5's
  tokenizer emits ~1.0-1.35x more tokens for the same text, and its adaptive thinking spends more per
  task.
- **Speed**: haiku beats even Sonnet-5-low on both axes (≈91 vs ≈57 output tok/s; ≈1.0s vs ≈1.6s
  time-to-first-token, per Artificial Analysis).
- **Official scoping**: Anthropic pitches Sonnet 5's `low` for "high-volume or latency-sensitive
  workloads... chat and non-coding use cases" — NOT as a coding tier. And their own suggested pattern
  is the ladder's: "Sonnet [5] can break down a complex problem into multi-step plans, then
  orchestrate a team of multiple Haiku 4.5s to complete subtasks in parallel."

The crossover between haiku and sonnet is **task-complexity, not price**: mechanical, single-file,
low-ambiguity work → haiku wins on cost and latency. The moment a subtask needs multi-step reasoning
or cross-file judgment, the step up is `sonnet·medium` (≈ Sonnet 4.6 at high, per Anthropic) — there
is no sweet spot where `sonnet·low` quietly does haiku's job at haiku's price. If you trust the
official scoping, `sonnet·low` is a candidate to disable in the effort grid for a coding board.

Haiku's hard limits for agent work: 200K context (vs 1M elsewhere), 64K max output, no effort
parameter, no adaptive thinking.

## How the ladder embodies this

- **Crossovers are real**: the sonnet↔opus boundary overlaps (`sonnet·xhigh` outranks `opus·low`)
  because published benchmarks show a mixed picture there. The opus↔fable boundary does NOT overlap —
  every published benchmark has Fable 5 ahead of Opus 4.8, so `fable·low` ranks strictly above
  `opus·xhigh`.
- **Fable's rungs follow its own guidance**: `fable·high` is the workhorse top-of-scale rung,
  `fable·xhigh` sits just under max for capability-sensitive scores, and `·max` fires only at
  complexity 10 (9 at bias +5) — matching "high for most tasks, xhigh for the most
  capability-sensitive, max for genuinely frontier problems."
- **Bias and the allowlist stay the user's dials**: the guidance above shapes the neutral ladder; the
  user's tier/effort toggles and bias slider reshape it. You never override either — if a derived rung
  looks wrong for a task, re-score with a fresh motivation; don't hand-pick a tier.

## The task-shape scale

Score by which official bucket the task's shape matches. The bands below are scoring anchors, not
routing promises — the ladder, bias, and allowlist decide the actual rung, and crossovers mean e.g. a
6 can legitimately land on `sonnet·xhigh`.

- **1–2 — subagent-shaped** (haiku's official bucket): the executor discovers nothing; the spec says
  everything. A fact lookup, a summary, a mechanical edit with exact anchors, a rename with known
  sites, a config bump, applying a given codemod.
- **3–5 — daily-coding-shaped** (sonnet's bucket): the everyday unit of work. Implement a function /
  endpoint / component against a known pattern, a scoped bugfix with a reproduction in hand, a
  single-area feature with a few edge cases. Judgment inside one area; no cross-cutting contract.
- **6–7 — complex-agentic-shaped** (opus's bucket): a multi-file feature, a contract several consumers
  must respect, a cross-cutting refactor with coordinated edits that must land together, real
  edge-case reasoning across boundaries.
- **8–10 — larger-than-a-sitting-shaped** (fable's bucket): unknown-root-cause debugging across a
  system, architecture design under real constraints, research-grade work with no established
  solution. **10 is the frontier end** (developing new models, RL training), not "a hard day."

Normal day-to-day coding legitimately lands 1–7. If a task straddles two bands, score lower and write
the tighter spec — a well-specified task drops a band; a vague one climbs.

## Honest caveats (what's official vs. what we run ahead of)

- Anthropic's newest multi-agent guidance says **start simple**: "multi-agent implementations
  typically use 3-10x more tokens than single-agent approaches", and their own examples run ONE tier
  for orchestrator and subagents. Routing every subtask to a scored tier is more elaborate than
  anything they document — the justification is cost control, not an official pattern.
- The quantified evidence for capable-orchestrator + cheaper-executors (Opus 4 lead + Sonnet 4 subs
  beating solo Opus 4 by 90.2%) is a **generation old**; no current-gen equivalent is published. The
  Claude Code subagents doc does state the pattern directly: "control costs by routing tasks to
  faster, cheaper models like Haiku."
- Model self-selection (a model freely picking its own tier) is NOT a documented Anthropic pattern.
  The documented primitives are plan-boundary switching (`opusplan`) and mid-task consultation (the
  advisor tool). The scored-rubric approach here stays inside that: judgment happens against this
  guide, the user's dials bound it.

## Sources

- Choosing the right model — platform.claude.com/docs/en/about-claude/models/choosing-a-model
- Models overview — platform.claude.com/docs/en/about-claude/models/overview
- Effort — platform.claude.com/docs/en/build-with-claude/effort
- Claude Code model configuration — code.claude.com/docs/en/model-config
- Create custom subagents — code.claude.com/docs/en/sub-agents
- Multi-agent research system — anthropic.com/engineering/multi-agent-research-system
- When to use multi-agent systems — claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- Introducing Claude Haiku 4.5 — anthropic.com/news/claude-haiku-4-5
- Prompting Claude Sonnet 5 — platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
- Artificial Analysis model pages (speed/cost-per-task data) — artificialanalysis.ai/models
