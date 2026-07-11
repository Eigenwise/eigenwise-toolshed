# Routing details: the ladder, bias, the effort grid

Read this when you need to explain or debug routing — which score lands on which rung, why a rung is
missing, what the bias slider does. Day-to-day you don't: every `list`/`ready` read stamps each ticket
with its derived `model`/`effort`, and those stamps are the routing. For WHY the ladder is shaped
this way — Anthropic's official model/effort guidance, with quotes and sources — see
[routing-guide.md](routing-guide.md).

## The capability ladder

sidequest maps complexity scores onto **one capability-ranked ladder** of model×effort rungs built
from the tiers the user enabled in the model picker (dashboard gear → Available models). Key
properties:

- **A single merged sequence, not per-tier bands.** Tiers overlap and cross over: `sonnet·xhigh`
  outranks `opus·low` — capability orders the rungs, not tier. Adjacent scores may share a rung.
- **Max effort is held out of the normal spread**: only complexity 10 on the top enabled tier gets
  `·max` (and 9 only at bias +5) — deliberately rare, per Anthropic's guidance to use max effort
  "sparingly for the hardest tasks".
- **Live derivation**: toggling a tier or effort instantly re-routes every open ticket. Nothing is
  stored on the ticket except the score; model/effort are stamped at read time.
- **Effort exclusion is per model×effort pair**, not global — `opus·medium` can be off while
  `sonnet·medium` stays on. An excluded pair never appears in the ladder.
- `sidequest models` prints the current ladder; `--json` gives `routing` (the master switch), the
  enabled grid, and the score→rung map.

Tickets show `⚙C<score>→tier·effort` on their cards and in `list`/`ready`.

## Bias (the user's dial, not yours)

`sidequest bias <n>` (or the dashboard slider): `-5` Frugal … `0` neutral … `+5` Generous. Bias
gamma-curves the score→rung map — it tunes HOW eagerly scores escalate to pricier rungs, never what
you score. You always score complexity honestly against the task-shape scale in the main
skill. Extremes stay invariant: complexity 1 always hits the cheapest rung and 10 the top rung at any
bias.

## Worked example

Main session = fable, haiku disabled; ticket `SQ-12 ⚙C3→sonnet·max` (an odd ladder — only two tiers
enabled — but it's what the stamps say):

```
Agent(subagent_type: "sidequest-exec-max", model: "sonnet", name: "exec-sq12",
      prompt: claim SQ-12 → fix → verify → done)
```

The user re-enables haiku later → the same open ticket re-reads as `C3→sonnet·low` or lower — which is
why you always spawn from a **fresh** `ready`/`list --json --brief` read for the wave, never a stale
one. The executor claims with `--effort <its baked level>` and the board refuses a mismatch, so a
stale spawn just bounces (a wasted round-trip, not a wrong-tier execution).

## Detected models (codex-gateway)

If [codex-gateway](../../../codex-gateway) is installed alongside sidequest, its models join the same
ladder with zero manual config. codex-gateway writes a catalog at `~/.claude/codex-gateway/catalog.json`;
sidequest reads it (`lib/discovery.js`) and each entry becomes a toggleable tier. There's nothing to
type: no model ids, no anchors. Every detected model is **off until you enable it** in the dashboard
settings, so installing the gateway never silently reroutes your tickets to another subscription.

Each catalog entry carries a recommended **anchor** (one of the four built-in tiers). An enabled model
merges into the ladder at its anchor's capability score plus its effort index, and on an exact score
tie the built-in anchor wins. So the scale doesn't change: you still score the **task** on the same
absolute task-shape scale, and the anchor decides which rung a detected model lands on. Per-model
tweaks (enabled, efforts, anchor/offset override, color) live in `customOverrides` in `model-prefs.json`;
the catalog stays the source of the model definitions themselves.

Enabling a model generates its executor agents: `sidequest-exec-<slug>-<effort>.md` under
`~/.claude/agents/`, one per enabled effort, each pinning the real model id (e.g.
`claude-codex-gpt-5.6-sol[1m]`) in frontmatter. **Restart Claude Code (or `/reload-plugins`) to load
newly generated agents.** The headless `sidequest work` drainer resolves a custom slug to that same id
and spawns `claude -p --model <id>` directly. Effort is advisory on gateway models: the frontmatter
effort may not reach the upstream model, but it still drives which rung the tier occupies.

## Re-scoring

```bash
sidequest update SQ-8 --complexity 5 --why "wider than scored: it also rewires the reader path"
```

A changed score must arrive with a fresh `--why`; an unmotivated re-score is rejected.
