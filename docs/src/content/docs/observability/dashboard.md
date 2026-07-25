---
title: Dashboard
description: Inspect local Claude Code activity from one place.
---

The dashboard reads local telemetry from enabled projects. Use the project filter for one codebase, or the global view for a cross-project picture.

## Board routing

Sidequest boards show their selected routing profile, revision, category count, and local-change badge. The Board routing panel lets you choose a profile and preview a repoint before applying it. The preview calls out changed, missing, and added categories, ADD collisions, foreign-base rows, and prepared dispatches that will be superseded. Local rows keep their provenance, so pins and board-only categories remain visible after a profile change.

## Profile library

The Profile library lets you inspect and edit profile categories. Its header shows how many boards follow the profile, and a save explains how many boards receive the update. Rows carry Profile, Override, Pinned, Board-only, or Disabled badges. Retired profiles stay hidden unless you ask to include them. The global availability fallback remains above the profile controls.


Token panels split input, output, cache creation, and cache reads. The token cards are raw token counts. The USD card and the cost-by-token-type breakdown are API-equivalent cost estimates for the selected time range. The breakdown is a share of the range rather than a trend, and it uses the same range total as the card, so its four legend totals add up to the USD card within rounding. Cache reads are useful context consumption, but their 0.1× cost weight keeps them from dominating the cost estimate.

The model view shows which model routes are doing the work. The gateway view separates requests sent through Codex Gateway from direct Claude API activity. The “who is burning” view helps find projects, sessions, or models with the largest totals.

## Efficiency

- **Billed tokens per output token** compares billed input, cache, and creation tokens with generated output by query source. Lower is better. Main normally exceeds subagent, but a widening gap means the orchestrator is waking up with too much context.
- **Off-Anthropic offload share** shows the percentage of notional cost routed to Codex models, plus the offloaded and total figures. Higher means category routing is shifting more work onto the ChatGPT subscription. It is board-wide, so don't use the project filter to interpret it.
- **Auxiliary spend by model and project** ranks compaction, summarization, and background-work cost. A large or climbing entry is overhead nobody directly asked for.

MCP connection activity counts connection attempts by server and status. Claude Code names only plugin-hosted servers on that event, so IDE and user-configured servers are grouped as “unnamed (non-plugin server)” instead of being dropped. That event carries no project, so the panel is board-wide and shows up on the global dashboard only, not on the per-project ones.

![Token usage by model](../../../assets/screenshots/observability-tokens-models.png)

![Cost by board activity](../../../assets/screenshots/observability-board-costs.png)

![Gateway activity](../../../assets/screenshots/observability-mcp.png)

These are counts and derived cost estimates from local records. They are for finding patterns, not billing statements.
