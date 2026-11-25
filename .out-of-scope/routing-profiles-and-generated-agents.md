# No routing profiles and no generated agents

2026-11-16

**v1 had:** five routing tables, four row kinds, profile revisions, repoint and promote, 18 routing MCP tools, and 19 generated agent files, one per role and effort.

**Evidence:** The live data was 10 profiles and 107 entries. Sixteen default categories landed on only four distinct Claude routes. Five hand rebalances in one month each edited dozens of rows. Nothing routed to haiku or fable, and nothing used `max` effort.

**Decision:** One file holds tiers and categories, with defaults when it is missing. Two agent definitions, worker and scout, differ only in tools. Model and effort are set on the spawn.

**Would change if:** two projects need different routes and copying one file between them proves too hard.
