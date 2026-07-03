# Coding Style

*Last Updated: 2026-06-26*

## Tooling

ruff is the single linter and formatter, configured in `pyproject.toml`:

- `line-length = 100`, `target-version = "py310"`.
- Lint rules: `E`, `F`, `I` (isort), `B` (bugbear), `UP` (pyupgrade); `E501` ignored
  (the formatter handles wrapping).
- isort treats `haiku_jar` as first-party.
- Run `ruff check .` to lint and `ruff format .` to format.

## Conventions

| Kind | Convention | Example |
|------|------------|---------|
| Modules | short, lowercase, one concept each | `jar.py`, `storage.py` |
| Classes | PascalCase | `Haiku`, `Jar`, `EmptyJarError` |
| Functions | snake_case; private helpers prefixed `_` | `default_path`, `_parse_lines` |
| CLI handlers | `_cmd_<subcommand>` | `_cmd_add`, `_cmd_draw` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_PATH`, `ENV_VAR`, `_CANONICAL_SHAPE` |

## Notes

- Every module starts with `from __future__ import annotations` and uses modern type
  hints (`X | None`, builtin generics).
- Public functions and classes carry docstrings; several have a light lyrical touch,
  in keeping with the subject, but the logic stays plain and conventional.
- Exit codes are explicit: handlers return an `int`, and `main()` returns it.
