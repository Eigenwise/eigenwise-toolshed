# Where each kind of finding lands

One finding, one destination. Prefer the highest entry that fits: installable things beat written
rules, written rules beat asking the user to remember.

## 1. Plugin install

For capability gaps: repeated manual work that an existing plugin covers.

- Search: `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --query "<terms>"`. Results come
  from the official catalog cache (with install counts) plus every marketplace manifest on this
  machine. Empty results with a plausible need: try different terms before concluding nothing fits.
- Cost check before proposing: `claude plugin details <name>@<marketplace>` shows components and
  projected token cost. A plugin whose always-on cost outweighs the friction it removes is a bad
  trade; say so.
- Apply: `claude plugin install <name>@<marketplace> --scope user` (project scope if it is clearly
  project-specific). Tell the user new hooks and MCP servers take effect on the next session.
- Fingerprint: `plugin-install:<name>`.

## 2. Plugin disable / uninstall

For installed plugins with no recorded activity across a real window (20+ sessions), after
checking the plugin is not hook-only or context-injection-only.

- Apply: `claude plugin disable <name>@<marketplace>` (reversible; prefer over uninstall).
- Fingerprint: `disable:<name>`.

## 3. MCP server

Only when no plugin wraps the capability. Search the registry:
`https://registry.modelcontextprotocol.io/v0/servers?search=<terms>` (WebFetch, JSON). Apply with
`claude mcp add <name> ...` per the server's own instructions, user scope by default.
Fingerprint: `mcp:<name>`.

## 4. Permission rule

For `permission-rule` denials that keep hitting the same safe pattern.

- Target file: project `.claude/settings.json`, key `permissions.allow`, array of rule strings
  like `Bash(npm test:*)` or `Read(src/**)`. Global patterns go in `~/.claude/settings.json`.
- Show the exact rule strings and which denied calls they would have allowed. Never propose a
  blanket allow (`Bash(*)`); scope to the observed pattern.
- `user-rejected` denials are NOT allowlist material: the user said no to the action itself.
  Those route to a rule about not doing the thing.
- Fingerprint: `permission:<tool>:<pattern>`.

## 5. Rule (live-rules or CLAUDE.md)

For repeated corrections on one theme, conventions, and "stop doing X" findings.

- If the live-rules plugin is installed (check `catalog --installed` for `live-rules@`), use its
  add-rule skill: rules there inject only when they apply (keyword, glob, or dir scoped) instead
  of costing context every prompt. Prefer it.
- Else: project conventions go in the project's `CLAUDE.md`; the user's personal preferences
  (voice, workflow, cross-project habits) go in `~/.claude/CLAUDE.md`. Keep the added rule to a
  few lines, in the file's existing style, and show the exact diff first.
- Fingerprint: `rule:<theme-slug>`.

## 6. New skill

For a recurring multi-step workflow (same command sequences across sessions) with no plugin
match. Suggest building it with skill-creator if installed, otherwise a plain
`.claude/skills/<name>/SKILL.md`. Fingerprint: `skill:<name>`.

## 7. No destination

Some friction is situational: a one-off bad day, a hard problem, an experiment. Naming it and
moving on is better than inventing a rule for it. Not every finding deserves an action.
