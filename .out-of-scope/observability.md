# Observability: dropped from v2, then brought back

2026-11-22, and 2026-11-25

**Asked:** a local per-turn usage ledger, including which model each routed agent actually ran on.

**Evidence on 2026-11-22:** it worked where it was switched on, and it recorded nothing until `/observe on` was typed in a project, which an upgrade had to say out loud so nobody thought they were still being recorded. No decision in v2 was made from its ledger.

**Decision (2026-11-22):** dropped. The plugin was taken out of the tree and the marketplace file, and the upgrade treated the older version's plugin of that name as having no v2 counterpart.

**What would bring it back:** a named need the host's own usage views do not cover.

**What changed (2026-11-25):** a team switched the older version on and uses its board, and the owner decided it comes along: per developer, local, under the same name. So it is back as `observability` 2.0.0 (`plugins/observability`), with the older version's recording switch and its page of charts (the page's command is now `usage-page`) and this repository's earlier per-session ledger and text report. An install of the older version updates in place at the switch, keeps its switch per project and keeps its history: every row the older version wrote is still read. The upgrade no longer offers to uninstall it or delete its data. No team total is built: each developer's ledger stays on their machine.

**What stays out:** a collector, an exporter, a server, a container, a status line, a price table, a quality field, a timer that outlives a turn, and anything that sends data off the machine. Not checked: whether the host's own usage views would have covered what that team wants.
