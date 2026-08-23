# Where each kind of finding lands

One finding, one destination. Prefer the highest entry that fits: things that add a capability beat
things that remove an annoyance, installable things beat written rules, and written rules beat
asking the user to remember.

This orders *destinations*, not findings. A finding's rank in what you propose comes from how well
the evidence carries it, so a measurement you inferred from one session title still lands below a
denial pattern you can count, even though its destination sits at the top of this list.

## 1. Measurement skill (an instrument)

For a standard the user cares about that nothing can currently check: correctness, reliability,
performance, coverage, cost. This sits at the top because an unverifiable goal cannot be closed,
and because no friction counter will ever surface it.

- Build it with skill-creator as a skill whose `scripts/` hold the measurement, committed in the
  repo. A scratch script is gone by the next session, and the number it produced becomes an
  assertion nobody can re-check.
- Scope it to one question with a defensible answer. "Does the output match the reference on the
  real corpus" is an instrument; "is the pipeline good" is not.
- This is not only a code move. A standard that cannot be checked shows up anywhere: whether a
  document still covers what it claims, whether an export matches its source, whether deployed
  config matches the repo, whether a dataset has the rows it should. The instrument differs; the
  reasoning does not.
- Have it report its own weaknesses next to its numbers: what the sample excludes, which
  population it actually measured, what it cannot separate. An instrument that names its blind
  spot can be trusted; one that hides it produces confident wrong conclusions.
- Check for an existing one first (`ls .claude/skills/`, `catalog --installed`). Test suites,
  benchmarks, linters, and validation scripts are instruments too, and extending one beats writing
  a second that measures nearly the same thing.
- Fingerprint: `skill:<name>`.

## 2. Plugin install

For a capability gap an existing plugin already covers: work done by hand that someone has
packaged.

- Search: `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --query "<terms>"`. Results
  come from the official catalog cache (with install counts) plus every marketplace manifest on
  this machine. Empty results with a plausible need: try different terms before concluding nothing
  fits.
- Cost check before proposing: `claude plugin details <name>@<marketplace>` shows components and
  projected token cost. A plugin whose always-on cost outweighs what it saves is a bad trade; say
  so.
- Apply: `claude plugin install <name>@<marketplace> --scope project`. New hooks and MCP servers
  take effect on the next session.
- Fingerprint: `plugin-install:<name>`.

## 3. New skill (a workflow)

For a multi-step workflow the user keeps performing by hand with no plugin match. Build it with
skill-creator; a hand-rolled SKILL.md tends to capture the one example in front of you and
under-trigger later. Fingerprint: `skill:<name>`.

## 4. Project knowledge

For facts and layout that keep being re-derived: repeated exploration of the same area, the same
question re-answered across sessions.

- If codebase-mapper is installed, the fix is a map doc under `.claude/.codebase-info/` via its
  `update-codebase-map` skill; the index is injected at session start, so the knowledge arrives
  before anyone looks for it.
- Otherwise a short section in the project's `CLAUDE.md`.
- Durable decisions and constraints belong here too, not in a rule. Rules govern behavior;
  knowledge answers questions.
- Fingerprint: `knowledge:<area-slug>`.

## 5. MCP server

Only when no plugin wraps the capability. Search the registry:
`https://registry.modelcontextprotocol.io/v0/servers?search=<terms>` (WebFetch, JSON). Apply with
`claude mcp add --scope project <name> ...` per the server's own instructions. This writes the repo's
`.mcp.json`, so the server lands only in the project that asked for it. The CLI defaults to user scope
if no `--scope` flag is passed.
Fingerprint: `mcp:<name>`.

## 6. Rule (live-rules or CLAUDE.md)

For repeated corrections on one theme, conventions, and "stop doing X" findings.

- If the live-rules plugin is installed (check `catalog --installed` for `live-rules@`), use its
  add-rule skill: rules there inject only when they apply (keyword, glob, or dir scoped) instead of
  costing context every prompt. Prefer it.
- Else: project conventions go in the project's `CLAUDE.md`; the user's personal preferences
  (voice, workflow, cross-project habits) go in `~/.claude/CLAUDE.md`. Keep the added rule to a few
  lines, in the file's existing style, and show the exact diff first.
- Fingerprint: `rule:<theme-slug>`.

## 7. Permission rule

For `permission-rule` denials that keep hitting the same safe pattern.

- Target file: project `.claude/settings.json`, key `permissions.allow`, array of rule strings like
  `Bash(npm test:*)` or `Read(src/**)`. Global patterns go in `~/.claude/settings.json`.
- Show the exact rule strings and which denied calls they would have allowed. Never propose a
  blanket allow (`Bash(*)`); scope to the observed pattern.
- `user-rejected` denials belong in a rule about not doing the thing, not on the allowlist: the user
  said no to the action itself, so allowing it is the opposite of what they asked for.
- Fingerprint: `permission:<tool>:<pattern>`.

## 8. Plugin disable / uninstall

For installed plugins with no recorded activity across a real window (20+ sessions), after
checking the plugin is not hook-only or context-injection-only.

- Apply: `claude plugin disable <name>@<marketplace>` (reversible; prefer over uninstall).
- Fingerprint: `disable:<name>`.

## 9. No destination

Some expense is situational: a genuinely hard problem, an experiment, a one-off bad day. Naming it
and moving on beats inventing a rule for it. Not every finding deserves an action, and a pass that
proposes nothing is a real outcome.
