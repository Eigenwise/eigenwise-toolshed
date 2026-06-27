# Codebase Map: haiku-jar

*Last Updated: 2026-06-26*

A tiny command-line program that keeps haiku in a JSON file and draws one back out
at random. It exists as a sample for the **codebase-mapper** plugin: small enough
to read in a minute, with the map it produces committed right here beside it.

**Stack:** Python 3.10+ · standard library only · argparse CLI · hatchling · pytest · ruff
**Shape:** small layered CLI (command line → core model → file storage)

## Documents

| Document | What's inside |
|----------|---------------|
| [architecture.md](./architecture.md) | The CLI → Jar → storage picture and how a command flows through it |
| [tech-landscape.md](./tech-landscape.md) | Python, the stdlib modules used, build and dev tooling, source-of-truth files |
| [directory-structure.md](./directory-structure.md) | Annotated tree |
| [entry-points.md](./entry-points.md) | The console script, `python -m haiku_jar`, and the four subcommands |
| [modules.md](./modules.md) | `haiku` · `jar` · `storage` · `cli` |
| [patterns.md](./patterns.md) | Value object, layering, injected randomness, error handling, testing, config |
| [coding-style.md](./coding-style.md) | Conventions derived from the ruff config and the code |
| [onboarding.md](./onboarding.md) | Quick start and common tasks |

*This project has no database, no containers, and no network APIs, so
`database.md`, `docker.md`, `communication.md`, and `dependencies.md` are
intentionally absent. The map only carries the docs that apply.*

## How to use this map

- New here? Read `onboarding.md` then `architecture.md`.
- Before touching code, skim the doc(s) for the area you're changing.
- These docs hold concrete file paths; use them to navigate straight to the code.

## Keeping this map current

After a change that affects architecture, directory structure, dependencies, entry
points, or conventions, refresh the affected docs with the `update-codebase-map`
skill (`/codebase-mapper:update-codebase-map`). Small, internal-only changes don't
need an update.
