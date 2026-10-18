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

1. Take the external item (e.g. `EXAMPLE-0001`) and, if it's more than a trivial change, **decompose it
   into local sidequest tickets** — one per independent piece, `--file`-scoped, same as any other
   plan. Mirror the external item in `refs`; titles need no prefix:
   `sidequest add -t "Document a placeholder change" --refs EXAMPLE-0001 ...`.
   Accepted forms: `GH-123` or `#123` (GitHub origin required), `owner/repo#123`, GitHub
   issue/pull URLs, and Jira keys such as `EXAMPLE-123`. Set `board_config.jiraBaseUrl`
   (CLI `board-config --jira-base-url https://team.atlassian.net`) to link Jira keys;
   without it their URL is null. Refs dedupe by key; update replaces the list, and MCP
   `refs: []` clears it. Full reads include URLs; compact reads and briefings show keys.
   `sidequest add --github <url>` imports through `gh issue view` or `gh pr view`, strips
   HTML comments and Markdown/HTML images, and records the URL in refs. Imported titles
   use `GH-<number>: <title>`; manually written titles need no prefix. Run `gh auth login`
   if authentication fails.
2. **Execute per the normal delegation rules** (main skill) — the presence of a Jira ticket changes
   nothing about how you parallelize or route the work.
3. **Record findings on the sidequest ticket**, not just in the PR — root cause, `file:line`, what
   you ruled out — so a later agent (or you, post-compaction) can pick it up.
4. When the work lands, prepare a sanitized external tracker or PR update. Post it only when an
   existing user or team authorization applies to that public action. Otherwise leave the prepared
   update as a local handoff; sanitation controls content, not posting authority.

GitHub issue bodies, comments, replies, and closure notes you author must stand alone: summarize a
sanitized reproduction, relevant findings, and version, with only publicly resolvable issue, PR,
commit, or release links. Omit local `SQ-`/`US-` identifiers, board slugs, local-only evidence paths,
and board-only references; summarize that evidence directly instead. Keep those references in local
Sidequest threads with the GitHub link back. Preserve reporter text unless you are authorized to edit
it, and do not strip diagnostic error text or hand-edit historical changelogs or generated release
history.

## Opt-in GitHub updates

`board_config.githubSync` (CLI `sidequest board-config --github-sync off|comment|close`) defaults
to `off` and appears in board-config output:

- `off`: no GitHub writes.
- `comment`: one comment per linked GitHub ref when delivery is recorded, `Fixed on <branch> in <sha> (<ticket ref>)`, then `Shipped in <tag>` after the GitHub Release is confirmed published.
- `close`: the same comments, then closes linked issues after that published release. Delivery alone never closes them. A deferred GitHub Release emits no shipped update.

Enable a mode only with existing user or team authorization for those GitHub writes. Setting the mode
records that opt-in; linking refs alone grants no posting authority. The authenticated `gh` account
must have permission in every linked repository. These automatic delivery comments include only the
branch, commit and ticket ref; this is the narrow exception to omitting local ticket identifiers above.
Jira refs are ignored. Failed commands leave a local ticket comment and do not block delivery or release.
No retry queue or duplicate suppression across separate release invocations is provided.

Short version: **Jira says *what* to build; sidequest is *how you execute it* here.** One doesn't
substitute for the other.
