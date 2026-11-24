# Observability: dropped from v2

2026-11-22

**Asked:** a local per-turn usage ledger, including which model each routed agent actually ran on.

**Evidence:** it worked where it was switched on, and it recorded nothing until `/observe on` was typed in a project, which an upgrade had to say out loud so nobody thought they were still being recorded. No decision in v2 was made from its ledger.

**Decision (2026-11-22):** dropped. The plugin (`plugins/observability`) is out of the tree and out of the marketplace file. Outfit does not offer it. The upgrade treats the older version's plugin of that name as having no v2 counterpart.

**What would bring it back:** a named need the host's own usage views do not cover. None is on record.

**What stays:** Sidequest still keeps its `sidequest.runs` state key, because its own pane and hooks read it. A ledger an older or earlier version wrote under the config folder (`observability/ledger/`) is the person's history: nothing in v2 reads it and nothing removes it.
