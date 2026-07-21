---
title: Dashboard
description: Inspect local Claude Code activity from one place.
---

The dashboard reads local telemetry from enabled projects. Use the project filter for one codebase, or the global view for a cross-project picture.

## Board routing

Sidequest boards show their selected routing profile, revision, category count, and local-change badge. The Board routing panel lets you choose a profile and preview a repoint before applying it. The preview calls out changed, missing, and added categories, ADD collisions, foreign-base rows, and prepared dispatches that will be superseded. Local rows keep their provenance, so pins and board-only categories remain visible after a profile change.

## Profile library

The Profile library lets you inspect and edit profile categories. Its header shows how many boards follow the profile, and a save explains how many boards receive the update. Rows carry Profile, Override, Pinned, Board-only, or Disabled badges. Retired profiles stay hidden unless you ask to include them. The global availability fallback remains above the profile controls.


Token panels split input, output, cache creation, and cache reads. The token cards are raw token counts. The USD card and the cost-by-token-type chart are API-equivalent cost estimates for the selected time range. The chart uses the same range total as the card, so its four legend totals add up to the USD card within rounding. Cache reads are useful context consumption, but their 0.1× cost weight keeps them from dominating the cost estimate.

The model view shows which model routes are doing the work. The gateway view separates requests sent through Codex Gateway from direct Claude API activity. The “who is burning” view helps find projects, sessions, or models with the largest totals.

![Token usage by model](../../../assets/screenshots/observability-tokens-models.png)

![Cost by board activity](../../../assets/screenshots/observability-board-costs.png)

![Gateway activity](../../../assets/screenshots/observability-mcp.png)

These are counts and derived cost estimates from local records. They are for finding patterns, not billing statements.
