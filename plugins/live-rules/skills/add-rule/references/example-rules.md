# Example Rules

Copy and adapt these. Each is a complete `.claude/rules/<name>.md` file. They are illustrative, so
swap in the real conventions of the project.

## Global (always-on)

`house-style.md` - injected on every prompt:

```markdown
---
description: House writing style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon. Write like a human, not a press release.
```

`commit-hygiene.md`:

```markdown
---
description: Commit and branch hygiene
priority: 5
---
- Never commit directly to main; branch first.
- Run the test suite before committing.
- Keep commits focused; one logical change per commit.
```

## Path / glob scope

`react-components.md` - injected before editing a React component:

```markdown
---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
- Co-locate the test as ComponentName.test.tsx next to the component.
```

`sql-safety.md` - any SQL file, at any depth (no slash in the glob):

```markdown
---
description: SQL safety
globs: ["*.sql"]
priority: 10
---
- Always use parameterized queries; never string-concatenate user input.
- Every destructive migration needs a tested down-migration.
```

`python-style.md`:

```markdown
---
description: Python conventions
globs: ["**/*.py"]
---
- Use httpx, not requests.
- Full type hints on public functions.
- Raise specific exceptions; never bare `except:`.
```

## Directory scope

`api-layer.md` - injected when editing anything under the API package:

```markdown
---
description: API layer rules
dirs: ["packages/api", "services/gateway"]
---
- All endpoints validate input with the shared zod schemas in packages/api/schemas.
- Return the standard error envelope from packages/api/errors.ts; do not invent ad hoc shapes.
```

## Prompt-keyword scope

`deploy-checklist.md` - injected when the prompt mentions deploying:

```markdown
---
description: Deploy checklist
prompt: ["deploy", "release", "ship to prod"]
---
- Confirm the staging smoke tests passed.
- Bump the version and update CHANGELOG.md.
- Post in #releases after the rollout completes.
```

`migration-care.md` - regex match across "migrate" / "migration":

```markdown
---
description: Database migration care
prompt: ["/migrat(e|ion)/i"]
---
- Write the migration and its rollback together.
- Run it against a copy of prod-shaped data before merging.
```

## Combined scope

`auth-care.md` - fires both when editing auth files and when the prompt mentions auth:

```markdown
---
description: Authentication is high-risk
globs: ["**/auth/**", "**/*auth*.ts"]
prompt: ["auth", "login", "session", "token"]
priority: 20
---
- Never log tokens, passwords, or session identifiers.
- All auth changes need a second reviewer.
- Use the existing session helpers in src/auth/session.ts; do not roll your own.
```

## Temporarily disabling a rule

Keep the file, flip one field:

```markdown
---
description: Strict lint gate (paused during the big refactor)
globs: ["**/*.ts"]
enabled: false
---
- Treat all eslint warnings as errors.
```
