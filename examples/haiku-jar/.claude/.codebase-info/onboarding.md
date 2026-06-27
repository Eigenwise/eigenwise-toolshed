# Onboarding

*Last Updated: 2026-06-26*

## Prerequisites

- Python 3.10 or newer. Nothing else: there are no runtime dependencies.

## Quick Start

```bash
cd examples/haiku-jar
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"                              # installs the haiku-jar command + pytest/ruff

haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho
haiku-jar add "the light of a candle / is transferred to another candle / spring twilight" --author Buson
haiku-jar list
haiku-jar draw
```

No install needed if you'd rather not: `PYTHONPATH=src python -m haiku_jar draw`.

## Common Commands

| Command | Purpose |
|---------|---------|
| `haiku-jar add "…/…/…" --author X` | Add a haiku |
| `haiku-jar draw` | Print a random haiku |
| `haiku-jar list` / `haiku-jar count` | List or count what's stored |
| `pytest` | Run the test suite |
| `ruff check .` / `ruff format .` | Lint / format |

## Common Tasks

- **Add a subcommand:** add a `_cmd_<name>` handler in `cli.py`, register a parser
  for it in `build_parser()` with `set_defaults(func=…)`, then cover it in
  `tests/test_jar.py`.
- **Change where the jar is stored:** set `HAIKU_JAR_PATH`, or change
  `DEFAULT_PATH` in `storage.py`.
- **Change the on-disk format:** edit `storage.load()` / `storage.save()`; keep the
  round-trip test green.

## Gotchas

- The 5-7-5 check (`Haiku.is_well_formed`) counts vowel groups and is only an
  approximation. It never blocks an add; it just notes when a haiku's shape wanders.
- The jar file (`haiku-jar.json`) is git-ignored, so running the tool won't dirty
  the repo.
- This is a `src/` layout: import as `haiku_jar`, and run tests against the installed
  package (or with `PYTHONPATH=src`).
