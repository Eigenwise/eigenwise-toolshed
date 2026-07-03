# Directory Structure

*Last Updated: 2026-06-26*

## Root Layout

```
haiku-jar/
├── src/haiku_jar/        # the package (src layout)
│   ├── __init__.py       # package doc; re-exports Haiku, Jar, EmptyJarError
│   ├── __main__.py       # enables `python -m haiku_jar`
│   ├── cli.py            # argparse entry point and subcommand handlers
│   ├── haiku.py          # the Haiku value object + syllable estimate
│   ├── jar.py            # the Jar collection + EmptyJarError
│   └── storage.py        # JSON load/save + jar-file path resolution
├── tests/
│   ├── __init__.py
│   └── test_jar.py       # haiku, jar, storage round-trip, and CLI tests
├── .claude/
│   ├── settings.json     # enables codebase-mapper for this example
│   └── .codebase-info/   # this map (committed)
├── pyproject.toml        # metadata, build, console script, ruff + pytest config
├── .gitignore
└── README.md             # how to run the mapper on this project
```

## Key Directories

### src/haiku_jar/
The whole program. It uses a `src/` layout (the importable package sits under
`src/`, not at the repo root) so tests run against the installed package rather
than loose files. Organizing principle is **by layer**: `cli` (interface),
`jar` + `haiku` (core), `storage` (persistence).

### tests/
A single `test_jar.py` covering each piece: the `Haiku` value object, the `Jar`
(including a seeded, repeatable draw), the storage round-trip via `tmp_path`, and
the CLI via `main([...])` with `HAIKU_JAR_PATH` pointed at a temp file.
