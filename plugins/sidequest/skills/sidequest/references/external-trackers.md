# Running sidequest alongside Jira / Linear / GitHub Issues

Read this when the repo already has an external tracker and you're tempted to skip the board because
the work is "already tracked". Don't — they track different things.

- **The external tracker owns the deliverable.** It's the system-of-record humans read: the story,
  the acceptance criteria, the status the team reports on. You don't replace it, and you usually
  don't file there on the model's behalf.
- **sidequest owns your local execution.** It's the agent's working ledger for *this* session: how
  you cut the external item into parallel-safe pieces, coordinate claims across agents so nothing
  collides, and write spike findings back as comments that outlive your context. None of that belongs
  in Jira, and none of it happens on its own.

How to run both, in practice:

1. Take the external item (e.g. `CTR-13316`) and, if it's more than a trivial change, **decompose it
   into local sidequest tickets** — one per independent piece, `--file`-scoped, same as any other
   plan. Mirror the external ref in the title so the link is obvious:
   `sidequest add -t "CTR-13316: guard ILIKE against <3-char variants" ...`.
2. **Execute per the normal delegation rules** (main skill) — the presence of a Jira ticket changes
   nothing about how you parallelize or route the work.
3. **Record findings on the sidequest ticket**, not just in the PR — root cause, `file:line`, what
   you ruled out — so a later agent (or you, post-compaction) can pick it up.
4. When the work lands, update the **external** tracker/PR as the team expects; the sidequest tickets
   were your scaffolding and can just be marked `done`.

Short version: **Jira says *what* to build; sidequest is *how you execute it* here.** One doesn't
substitute for the other.
