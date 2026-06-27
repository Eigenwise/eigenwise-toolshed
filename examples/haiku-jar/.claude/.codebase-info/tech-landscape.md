# Technology Landscape

*Last Updated: 2026-06-26*

## Source-of-Truth Files

| Information | File |
|-------------|------|
| Package metadata, build, scripts, tooling config | `pyproject.toml` |
| The program itself | `src/haiku_jar/` |
| Tests | `tests/test_jar.py` |
| Ignored paths (incl. the runtime jar file) | `.gitignore` |

## Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Language | Python | `requires-python >=3.10` (uses `X | Y` unions, modern type hints) |
| Runtime deps | none | standard library only (see below) |
| CLI | `argparse` | subcommands built in `cli.build_parser()` |
| Storage | `json` + `pathlib` | a single JSON file on disk |
| Build | Hatchling | `src/` layout; wheel packages `src/haiku_jar` |
| Tests | pytest | `tests/`, run with `pytest` |
| Lint/format | ruff | config in `pyproject.toml` (`[tool.ruff]`) |

## Standard-Library Modules Used

`argparse` (CLI), `json` (storage format), `pathlib` (paths), `os` (env lookup),
`random` (drawing), `dataclasses` (the `Haiku` value object), `re` (the syllable
estimate), `sys` (exit codes), `collections.abc` (typing).

## Infrastructure

None. There is no service to host, no container, and no CI defined inside this
example. It is a local command-line tool; "deploying" it means `pip install .`.
