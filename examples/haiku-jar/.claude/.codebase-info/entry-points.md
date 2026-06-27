# Entry Points

*Last Updated: 2026-06-26*

## Entry Points

| Entry point | Type | Purpose | File |
|-------------|------|---------|------|
| `haiku-jar` | Console script | Installed command (`pip install .`) | `pyproject.toml` → `haiku_jar.cli:main` |
| `python -m haiku_jar` | Module run | Same CLI without installing | `src/haiku_jar/__main__.py` |
| `haiku-jar add` | Subcommand | Add a haiku (`"line / line / line"`, `--author`) | `cli._cmd_add` |
| `haiku-jar draw` | Subcommand | Print a random haiku | `cli._cmd_draw` |
| `haiku-jar list` | Subcommand | List every haiku in the jar | `cli._cmd_list` |
| `haiku-jar count` | Subcommand | Print how many haiku are stored | `cli._cmd_count` |

All four subcommands are wired in `cli.build_parser()`; `cli.main()` parses argv
and calls the selected handler, returning its process exit code.

## Representative Flow

`haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho`

1. `main()` → `build_parser()` parses the subcommand and arguments.
2. `_cmd_add` calls `_parse_lines()` to split the text into three lines and builds
   a `Haiku`.
3. `storage.load()` reads the current jar (a missing file is an empty jar).
4. `Jar.add()` appends the haiku; `storage.save()` writes the jar back as JSON.
5. The handler prints a confirmation and returns `0`.
