# Routing: the older categories and v2's tiers

The older board routed each category through a profile to a model and effort. v2 routes a category to one of four tiers in `.sidequest/board.json` (light, standard, deep, top), and its default categories cover the starter coding profile. The scan prints this project's old routes; show them with the lines below and what has no place yet.

## The older categories in v2

| Older category (coding profile) | v2 category, tier | What is lost |
| --- | --- | --- |
| codebase-exploration, implementation-explanation | explore, light | the "may write one map file" scope |
| source-lookup, evidence-research, spike-investigation | research, deep | source-lookup was a cheaper bounded lookup; a custom category on light keeps that |
| research.evidence | research, deep | writing evidence files under evidence roots: no place |
| debugging | debug, deep | |
| coding.easy | quick, light | |
| coding.normal, behavior-verification, interaction-design-implementation | build, standard | the demonstrations evidence and the chart contract: no place |
| coding.hard | hard, deep | |
| review-audit, visual-evaluation | review, deep | the complexity table report format and the screenshot record: no place |
| general | `settings.unrouted` (default build) | |
| experiment (a person judges blind rounds on pinned refs) | no place; nearest is a `hitl` ticket on hard | the round machinery |

The scan carries the same list: it offers as custom only the older categories this table gives no v2 category (experiment, and any of the project's own), since v2's defaults already route the rest.

What maps: category to tier, the model alias, the effort (v2 takes `low` to `max`, so `xhigh` maps), one fallback per tier. A route or fallback on the top model goes to the `top` tier.

## Converted by hand

The project's own categories (the scan's `custom-routing` line) become custom categories in that project's `.sidequest/board.json`. The scan prints one ready line for each, derived from the old route by the mapping above:

```json
"docs": { "tier": "standard", "role": "worker", "description": "Was docs." }
```

Write exactly the scan's lines under `categories`, and show them in your report. Do not invent or reword one. The tier comes from the route's model (haiku light, sonnet standard, opus deep, the top model top). Where the route's model is another provider's, the line takes the tier of its Claude fallback, or standard with no fallback, and its description says so. A read-only category gets role `scout`, anything else `worker`, as the old board recorded it. The board file is personal, so deleting the lines undoes it, and it is no question for the person. `sidequest:setup` keeps custom categories when it runs later.

A category counts as written only when the board file has a category of that name. Once every own category is there, the scan lists the routing under Kept as written already. The old routes print once, under Old routes: do not list them again.

A project whose older board ran every agent in the main checkout (worktree isolation off) shows a `shared-checkout` line with one ready line, `"worktrees": false`. Write it exactly under `settings` in `.sidequest/board.json`, then write under `settings.checks` what the checks need that a worktree lacks (an ignored file, a shared database). It is personal and deleting it undoes it. Once the setting is there the scan lists it under Kept.

## No place yet

Say these plainly, once, when the scan shows them:

- **Routes and fallbacks on models from other providers** (`other-provider-routes`): v2 has no way to run them yet. A tier on such a model falls back to a Claude model with a named reason. The old routes stay readable in the old board until the home cleanup.
- A contract per category: v2 has a one-line description. A contract that matters becomes a rule or a skill.
- A fallback per category: v2 has one per tier.
- Artifact roots, evidence writes, demonstrations, profile revisions.
