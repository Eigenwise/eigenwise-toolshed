# Document Templates

Templates for the atomic documents in `.claude/.codebase-info/`. Adapt each to the project — skip
sections that don't apply, add project-specific ones that do. Use the real current date
(`YYYY-MM-DD`) in every `Last Updated` line. Create only the documents that are relevant.

---

## INDEX.md

This is the most important file: the plugin's hook injects it into context at the start of each session, so keep it
**compact**. Summarize in a few lines and link out to the detailed docs (which are read on demand).

~~~markdown
# Codebase Map — [Project Name]

*Last Updated: YYYY-MM-DD*

[One or two sentences: what this project is and what it does.]

**Stack:** [e.g. TypeScript · Next.js · PostgreSQL · Docker]
**Shape:** [e.g. layered monolith / feature-modular / monorepo (apps + packages)]

## Documents

| Document | What's inside |
|----------|---------------|
| [architecture.md](./architecture.md) | System overview, components, boundaries, data flow |
| [tech-landscape.md](./tech-landscape.md) | Languages, frameworks, infra, source-of-truth files |
| [directory-structure.md](./directory-structure.md) | Annotated folder tree |
| [entry-points.md](./entry-points.md) | Where execution starts |
| [modules.md](./modules.md) | Key modules: purpose, deps, exports |
| [communication.md](./communication.md) | APIs, events, integrations |
| [database.md](./database.md) | Schema and relationships |
| [dependencies.md](./dependencies.md) | Categorized packages |
| [patterns.md](./patterns.md) | Patterns, error handling, testing, config |
| [coding-style.md](./coding-style.md) | Naming and style conventions |
| [docker.md](./docker.md) | Containers / local dev environment |
| [onboarding.md](./onboarding.md) | Quick start and common tasks |

*(List only the documents that were actually created.)*

## How to use this map

- New here? Read `onboarding.md` then `architecture.md`.
- Before touching code, skim the doc(s) for the area you're changing.
- These docs hold concrete file paths — use them to navigate straight to the relevant code.

## Keeping this map current

After a change that affects architecture, directory structure, dependencies, the data model, entry
points, APIs/events, or conventions, refresh the affected docs with the `update-codebase-map` skill
(`/codebase-mapper:update-codebase-map`). Small, internal-only changes don't need an update.
~~~

---

## architecture.md

~~~markdown
# Architecture

*Last Updated: YYYY-MM-DD*

## Summary
[2–3 paragraphs: what the system is, its major pieces, and how they fit together.]

## High-Level Diagram
[ASCII or Mermaid diagram of the major components and their connections.]

## Components
[Each major component: responsibility, where it lives, what it talks to.]

## Data Flow
[How a request/job moves through the system, end to end.]

## Key Decisions & Constraints
[Notable architectural choices, trade-offs, and hard constraints worth knowing.]
~~~

---

## tech-landscape.md

~~~markdown
# Technology Landscape

*Last Updated: YYYY-MM-DD*

## Source-of-Truth Files
| Information | File |
|-------------|------|
| Dependencies | [e.g. package.json] |
| Build/scripts | [e.g. Makefile, package.json scripts] |
| Config | [e.g. .env.example, config/] |

## Stack
| Layer | Technology | Notes |
|-------|------------|-------|
| Language(s) | | |
| Framework(s) | | |
| Runtime | | |
| Data store | | |
| Build/tooling | | |

## Infrastructure
[Hosting, CI/CD, containerization, monitoring, logging — as applicable.]
~~~

---

## directory-structure.md

~~~markdown
# Directory Structure

*Last Updated: YYYY-MM-DD*

## Root Layout
```
project/
├── src/        # ...
├── tests/      # ...
├── config/     # ...
└── ...
```

## Key Directories
### src/
[What goes here, naming patterns, the important files.]
~~~

---

## entry-points.md

~~~markdown
# Entry Points

*Last Updated: YYYY-MM-DD*

## Entry Points
| Entry point | Type | Purpose | File |
|-------------|------|---------|------|
| [e.g. POST /api/users] | HTTP route | Create a user | [src/...] |
| [e.g. `cli deploy`] | CLI command | Deploy | [src/...] |

## Representative Flow
[Trace one important request/job from entry point to its effects.]
~~~

---

## modules.md

~~~markdown
# Key Modules

*Last Updated: YYYY-MM-DD*

### [Module / package name]
- **Location:** `path/`
- **Purpose:** [what it does]
- **Key files:** [important files]
- **Depends on:** [other modules]
- **Exposes:** [what it provides to the rest of the system]

*(Repeat for each significant module.)*
~~~

---

## communication.md

~~~markdown
# Communication

*Last Updated: YYYY-MM-DD*

## APIs
[Endpoints/RPCs, versioning, auth method. Link to or summarize the contract.]

## Events & Messaging
[Queues, pub/sub, broadcasts, webhooks — producers and consumers.]

## External Integrations
[Third-party services and how the system talks to them.]
~~~

---

## database.md

~~~markdown
# Database

*Last Updated: YYYY-MM-DD*

## Overview
- **Engine:** [PostgreSQL / MySQL / SQLite / Mongo / ...]
- **Access layer:** [ORM/driver, e.g. Prisma / SQLAlchemy / Ecto]
- **Migrations:** [location]

## Key Tables / Collections
### table_name
| Column | Type | Notes |
|--------|------|-------|

## Relationships
[ASCII ER diagram or a short description of the important relationships.]
~~~

---

## dependencies.md

~~~markdown
# Dependencies

*Last Updated: YYYY-MM-DD*

## Runtime
### Core
| Package | Purpose |
|---------|---------|

### Data / External
| Package | Purpose |
|---------|---------|

## Development
| Package | Purpose |
|---------|---------|

## Notes
[Pinned versions, known constraints, anything surprising.]
~~~

---

## patterns.md

~~~markdown
# Patterns & Conventions

*Last Updated: YYYY-MM-DD*

## Code Organization
[Where things go and why.]

## Recurring Patterns
[Design patterns in active use, with a pointer to a canonical example file.]

## Error Handling
[How errors/exceptions/validation are handled.]

## Testing
[Test framework, where tests live, naming, how to run them, mocking approach.]

## Configuration
[How config and secrets are managed; env vars; feature flags.]
~~~

---

## coding-style.md

~~~markdown
# Coding Style

*Last Updated: YYYY-MM-DD*

## Tooling
[Linters/formatters and their config files; how they're enforced.]

## Conventions
| Kind | Convention | Example |
|------|------------|---------|
| Files | | |
| Types/Classes | | |
| Functions | | |
| Variables | | |
| Constants | | |

## Notes
[Anything a contributor should know that the linter doesn't enforce.]
~~~

---

## docker.md

~~~markdown
# Containers / Local Dev Environment

*Last Updated: YYYY-MM-DD*

## Overview
[What the container/compose setup provides.]

## Services
| Service | Image | Port | Purpose |
|---------|-------|------|---------|

## Common Commands
| Command | Purpose |
|---------|---------|

## Environment Variables
[Required vars and what they're for — names only, never values.]
~~~

---

## onboarding.md

~~~markdown
# Onboarding

*Last Updated: YYYY-MM-DD*

## Prerequisites
[Tools, versions, accounts needed.]

## Quick Start
[Clone → install → configure → run, as concrete commands.]

## Common Commands
| Command | Purpose |
|---------|---------|

## Common Tasks
[Step-by-step for frequent jobs: add a feature, run tests, create a migration, etc.]

## Gotchas
[Things that commonly trip people up, and how to get unstuck.]
~~~
