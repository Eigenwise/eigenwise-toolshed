# Example Rules

Copy and adapt these. Each example is one atomic rule file under
`.claude/live-rules/rules/`. After adding or editing a file, run the plugin-owned sync command:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-atomic-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

The examples are illustrative, so swap in the real conventions of the project.

## Global rule

Create `.claude/live-rules/rules/house-style.md`. It is eligible on normal prompts, then appears only
when it is new or changed in the current session:

```markdown
---
description: House writing style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon. Write like a human, not a press release.
```

A higher priority global rule can go in `.claude/live-rules/rules/commit-hygiene.md`:

```markdown
---
description: Commit and branch hygiene
priority: 5
---
- Never commit directly to main; branch first.
- Run the test suite before committing.
- Keep commits focused; one logical change per commit.
```

## Path or glob scope

Create `.claude/live-rules/rules/react-components.md`:

```markdown
---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
- Co-locate the test as ComponentName.test.tsx next to the component.
```

Any SQL file, at any depth, can use `.claude/live-rules/rules/sql-safety.md`:

```markdown
---
description: SQL safety
globs: ["*.sql"]
priority: 10
---
- Always use parameterized queries; never concatenate user input.
- Every destructive migration needs a tested down-migration.
```

## Directory scope

Create `.claude/live-rules/rules/api-layer.md` for files under the API package:

```markdown
---
description: API layer rules
dirs: ["packages/api", "services/gateway"]
---
- Validate endpoints with the shared schemas in packages/api/schemas.
- Return the standard error envelope from packages/api/errors.ts.
```

## Prompt-keyword scope

Create `.claude/live-rules/rules/deploy-checklist.md` for prompts about deployments:

```markdown
---
description: Deploy checklist
prompt: ["deploy", "release", "ship to prod"]
---
- Confirm the staging smoke tests passed.
- Check the release plan before changing version fields.
- Record the rollout result after it completes.
```

A regex can cover both migration spellings in `.claude/live-rules/rules/database-migration.md`:

```markdown
---
description: Database migration care
prompt: ["/migrat(e|ion)/i"]
---
- Write the migration and its rollback together.
- Run it against a copy of production-shaped data before merging.
```

## Combined scope

Create `.claude/live-rules/rules/auth-high-risk.md` to fire for auth edits or prompts:

```markdown
---
description: Authentication is high-risk
globs: ["**/auth/**", "**/*auth*.ts"]
prompt: ["auth", "login", "session", "token"]
priority: 20
---
- Never log tokens, passwords, or session identifiers.
- All auth changes need a second reviewer.
- Use the existing session helpers in src/auth/session.ts.
```

## Include a live file

Create `.claude/live-rules/rules/codebase-map-protocol.md`. The body is the protocol and `include:`
is the live payload:

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Read the relevant map document before exploring.
After changing code, assess whether the map needs updating.
```

If the map file does not exist, the rule stays silent. Any file can be included, but a compact hub such
as `INDEX.md` leaves room for the rule body and other matching rules.

## Temporarily disabling a rule

Keep the file and flip one field. Sync after saving:

```markdown
---
description: Strict lint gate (paused during the big refactor)
globs: ["**/*.ts"]
enabled: false
---
- Treat all lint warnings as errors.
```

## Legacy explicit override

Only when a project deliberately sets `LIVE_RULES_PATH`, the same frontmatter can be maintained in the
configured single file. That format is also what the SessionStart migration reads from the default
`.claude/live-rules.md`; it is not the path to choose for new work.
