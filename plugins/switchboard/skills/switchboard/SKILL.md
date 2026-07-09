---
name: switchboard
description: >-
  Complexity-scored routing for delegated work: "what model should handle this", "route this to
  the right model", "score this task", "delegate this", "spawn a worker for this", "run this on a
  cheaper model". Use proactively whenever you're about to hand a discrete task to a subagent —
  don't just run it on the session model, score it and let switchboard derive the tier.
---

# switchboard

## What it does

You score a task's **complexity (1-10) honestly**; switchboard derives the model and reasoning
effort from one capability-ranked ladder, shaped by the user's tier/effort preferences, and the
task runs in a **named executor subagent at exactly that tier**. You never pick the model or
effort directly — the score is the only knob you turn.

## The forcing function

There's nothing to file here to force honesty up front, so the rule is procedural instead:
**before spawning, state the score and a one-line motivation** — referencing the actual work (files,
moving parts, unknowns), not restating the number — **in your visible reply**. Only then run
`switchboard route <score>` and spawn what it says. Scoring silently, or picking the tier you
wanted and backfilling a score to match, is exactly the failure mode this exists to prevent.

## The absolute anchored scale

The scale is **absolute** — anchored to concrete reference points, not to "hard for me right
now." Each band maps to a rung on the ladder (below) and an orchestration shape:

- **1** — trivial: summarizing a README, a one-line lookup, skimming logs for a fact. → inline,
  or a single named subagent; nothing to parallelize.
- **2-3** — routine: a single-file edit or script, a rename, a dedup, a config bump. → a single
  NAMED subagent (serial one-off).
- **4-5** — everyday build: one area, a known pattern, a few edge cases; **~5 anchors to simple
  HTML work** — a static page, a form, a plain component. → a single named subagent, or a small
  **named fan-out** if it splits into independent pieces.
- **6-7** — hard: a multi-file feature or cross-cutting refactor — several coordinated edits, a
  contract multiple consumers must respect, real edge cases. → decompose and fan out named
  executors over the independent pieces; if that fan-out is sizable/repeatable, **propose a
  small-medium workflow** (<5-<15) if your environment has one.
- **8** — gnarly: novel debugging with an unknown root cause, or designing an algorithm/
  architecture under real constraints. → design → parallel named-executor wave → integrate;
  propose a medium workflow (<15) for the wave.
- **9-10** — frontier: developing new AI models, RL training, research-grade problems with no
  established solution. **10 is the extreme end**, not "a hard day." → staged waves of named
  executors; propose a medium-large workflow (<15-<50).

Normal day-to-day coding legitimately lands **1-7**. Scores of **9-10 firing rarely is intended**
— the top rung (`·max` effort) is reserved for genuinely extreme work, same spirit as
Anthropic's own guidance to use max effort sparingly for the hardest tasks. If you're unsure,
score lower.

## One score, three coupled outputs

The same complexity score drives three things at once, not just a model name:

1. **Model** — which tier works it (haiku < sonnet < opus < fable, capability-ranked, not a flat
   per-tier band — `sonnet·xhigh` can outrank `opus·low`).
2. **Effort** — how hard that model thinks (low/medium/high/xhigh/max).
3. **Orchestration shape** — a low, serial score → a single NAMED subagent. The moment there's
   independent work that can run at once → parallelize it, **by default as named-subagent
   fan-out** (spawn several named subagents in one message — always available). A **workflow** is
   a heavier tool for a larger, repeatable, or deterministic run — it is **gated**: you don't
   launch one on your own, the user opts in. You usually judge better than the user when one
   would help, so when you think so, **propose it** (e.g. via `AskUserQuestion`): explain *why*
   it fits, the rough scale, and the token cost, and let them pick. Staying silent when a
   workflow would clearly help is the mistake — but so is launching one uninvited. Default to
   named-subagent fan-out; propose a workflow only when the shape genuinely calls for it.

## Bias is the user's dial, not yours

You always score complexity honestly against the absolute scale above — bias tunes only **how
eagerly** those scores escalate to pricier rungs, never what you score. The user sets it with
`switchboard bias <n>` (`-5` frugal … `0` neutral … `+5` generous), gamma-curving the score→rung
map. Extremes stay invariant: complexity 1 always hits the cheapest rung and 10 the top rung at
any bias.

## Decision procedure

1. `switchboard models --json` once per session (or when prefs might have changed). If
   `routing` is `false`, stand down — work inline, derived tags are informational only.
2. Score the task and state the score + one-line motivation in your reply (the forcing function
   above).
3. `switchboard route <score> --json` to get that score's `model`/`effort` — or read the ladder
   once from the `models` call if you're routing a whole batch.
4. Cap at your own tier if the ladder tops out above you (`fable > opus > sonnet > haiku`), and
   only spawn models that actually exist in your environment.
5. Pick the orchestration shape by complexity (single named subagent / named fan-out in one
   message / propose a workflow) — see the scale above.
6. Spawn `subagent_type: switchboard-exec-<derived effort>` **with** `model: <derived tier>`
   **and** a unique lowercase-hyphen `name:` (e.g. `exec-auth-refactor`). A haiku-derived
   task has no effort axis: spawn a plain agent with `model: haiku`, still named. Include how to
   verify in the spawn prompt — executors verify the way you specify, not a default of their own.

There's no safety net here catching a mismatch after the fact. Matching the derived effort to the
exec name is entirely on you: **re-derive right before each spawn, never carry an effort across a
fan-out.** It's easy to pair the wrong exec with the wrong task when several scores are in flight
at once.

*Worked example:* session = sonnet, complexity scored 6 for "refactor the auth middleware to
support two token formats" → `switchboard route 6` → `opus·high`. The ladder tops out above the
session, so cap the **model** at sonnet and keep the derived **effort**. State: "C6, opus·high
capped to sonnet·high — touches three call sites and a shared token-parsing helper." Spawn:
`Agent(subagent_type: "switchboard-exec-high", model: "sonnet", name: "exec-auth-refactor",
prompt: "<task> — verify by running the auth test suite")`.

## Agent-teams / teammate notes

If agent teams are on, the same executor spawns as a teammate instead of a plain subagent — the
rules above don't change, but two things do:

- **Model never inherits the lead** — always pass `model: <tier>` explicitly, same as a subagent.
- **Effort may inherit the lead's reasoning effort** instead of what the named exec implies. Spawn
  the correctly-named executor anyway (its frontmatter pins the effort); if it matters, also state
  the effort in the spawn prompt.

A **generic or unnamed teammate throws the routing away** — it's not a switchboard executor, just
a bare background agent with a task description. Every worker, subagent or teammate, is a named
`switchboard-exec-<effort>` with its own unique `name`.

## The ~95/5 rule

Route by default, even when the derived tier equals yours — spawning still isolates context and
composes the effort level, which the main thread can't do for itself mid-run. Only genuinely
trivial one-step changes (complexity 1-2, a single obvious edit) stay in the main thread. "It's
easier to just do it here" is exactly the reflex this rule exists to catch.

## CLI reference

Invoke as `node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" <cmd>`.

- `models [--json]` — routing state, enabled tiers, per-model effort matrix, and the live ladder.
- `bias [<int>] [--json]` — read (no arg) or set (`-5`..`5`) the bias dial, then print the
  reshaped ladder.
- `route <complexity> [--json]` — derive one score's `model`/`effort` under current prefs.
- `enable <target...>` / `disable <target...>` — toggle a tier (`haiku`) or a model.effort pair
  (`opus.medium`).
- `routing on|off` — master switch; off means switchboard scores nothing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" models --json     # check routing is on, read the ladder
node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" route 6           # C6 → opus·high (example)
node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" bias -2           # nudge the ladder frugal
```
