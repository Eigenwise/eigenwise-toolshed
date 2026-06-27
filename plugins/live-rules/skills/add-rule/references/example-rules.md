# Example Rules

Copy and adapt these. Each is one rule **section** for your live-rules file (`.claude/live-rules.md`
by default). Drop the sections you want into the file, one after another; the `---` fence is what
separates them. They are illustrative, so swap in the real conventions of the project.

A small complete file looks like this:

```markdown
# Live rules

---
description: House writing style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon. Write like a human, not a press release.

---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
```

The rest of this file shows individual sections by scope.

## Global (always-on)

Injected on every prompt:

```markdown
---
description: House writing style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon. Write like a human, not a press release.
```

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

Injected before editing a React component:

```markdown
---
description: React component conventions
globs: ["**/*.tsx", "**/*.jsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
- Co-locate the test as ComponentName.test.tsx next to the component.
```

Any SQL file, at any depth (no slash in the glob):

```markdown
---
description: SQL safety
globs: ["*.sql"]
priority: 10
---
- Always use parameterized queries; never string-concatenate user input.
- Every destructive migration needs a tested down-migration.
```

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

Injected when editing anything under the API package:

```markdown
---
description: API layer rules
dirs: ["packages/api", "services/gateway"]
---
- All endpoints validate input with the shared zod schemas in packages/api/schemas.
- Return the standard error envelope from packages/api/errors.ts; do not invent ad hoc shapes.
```

## Prompt-keyword scope

Injected when the prompt mentions deploying:

```markdown
---
description: Deploy checklist
prompt: ["deploy", "release", "ship to prod"]
---
- Confirm the staging smoke tests passed.
- Bump the version and update CHANGELOG.md.
- Post in #releases after the rollout completes.
```

Regex match across "migrate" / "migration":

```markdown
---
description: Database migration care
prompt: ["/migrat(e|ion)/i"]
---
- Write the migration and its rollback together.
- Run it against a copy of prod-shaped data before merging.
```

## Combined scope

Fires both when editing auth files and when the prompt mentions auth:

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

## Include a live file

Inject a file's current contents under the body every prompt. This rule is a self-loading codebase
map: the body is the protocol, the `include:` is the map. If the map file does not exist, the rule
stays silent.

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Before starting any task, say which doc(s)
from .claude/.codebase-info/ you will read, and read them before exploring. After
changing code, review whether the map needs updating.
```

Any file works. Keep a planning doc in front of Claude while a feature is in flight:

```markdown
---
description: Current sprint focus
include: docs/sprint.md
---
- Work toward the goals in the included sprint doc; flag anything that pulls away from them.
```

## Temporarily disabling a rule

Keep the section, flip one field:

```markdown
---
description: Strict lint gate (paused during the big refactor)
globs: ["**/*.ts"]
enabled: false
---
- Treat all eslint warnings as errors.
```
