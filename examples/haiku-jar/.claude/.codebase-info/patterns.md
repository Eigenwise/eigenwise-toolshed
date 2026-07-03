# Patterns & Conventions

*Last Updated: 2026-06-26*

## Code Organization

Layered, dependencies pointing downward only: `cli` (interface) → `jar` + `haiku`
(core) → standard library, with `storage` bridging the core and the file system.
The core never imports argparse or touches the disk, which keeps it pure and
testable.

## Recurring Patterns

- **Value object.** `Haiku` is a frozen dataclass (`@dataclass(frozen=True)`), so it
  is immutable and compares by value. Canonical example: `src/haiku_jar/haiku.py`.
- **Dependency injection for randomness.** `Jar.draw(rng: random.Random | None)`
  lets a caller pass a seeded RNG instead of the global one, so the "random" draw is
  deterministic under test. Canonical example: `test_draw_is_repeatable_with_a_seed`.
- **Thin command handlers.** Each subcommand is a small `_cmd_*` function returning
  an exit code; `build_parser()` maps each to its handler via `set_defaults(func=…)`.

## Error Handling

Errors are explicit and narrow. `Jar.draw()` raises `EmptyJarError` on an empty jar;
`Haiku.__post_init__` and `cli._parse_lines` raise `ValueError` on bad input. The
CLI catches `EmptyJarError`, prints to stderr, and returns exit code `1`.

## Testing

pytest, in `tests/test_jar.py`. It covers the value object, the jar (including the
seeded draw), the storage round-trip (using the `tmp_path` fixture), and the CLI
(driving `main([...])` with `monkeypatch.setenv("HAIKU_JAR_PATH", …)` and asserting
on `capsys` output). Run with `pytest`.

## Configuration

One environment variable, read in `storage.default_path()`:

- `HAIKU_JAR_PATH`, where the jar file lives. Defaults to `./haiku-jar.json`.

No secrets, no config files. The runtime jar file is git-ignored.
