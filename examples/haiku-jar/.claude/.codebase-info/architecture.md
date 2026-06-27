# Architecture

*Last Updated: 2026-06-26*

## Summary

haiku-jar is a single-process command-line program with three thin layers. The
**command line** (`cli.py`) parses what you typed, the **core** (`jar.py`,
`haiku.py`) holds the haiku and decides which one to give back, and **storage**
(`storage.py`) reads and writes the jar as a JSON file on disk. There is no server,
no database engine, and no network: the whole program runs, does one thing, and
exits.

The layers only depend downward. `cli` calls `storage` and the core; `storage`
builds core objects; the core depends on nothing but the standard library. That
keeps the interesting logic (a value object and a small collection) free of any
argparse or file-system concerns, which is why it is so easy to test.

## High-Level Diagram

```
   you ──$ haiku-jar add "…/…/…"──▶ cli.py
                                      │  parse the three lines, build a Haiku
                                      ▼
                                   storage.load()  ──reads──▶ haiku-jar.json
                                      │
                                      ▼
                                    Jar  (jar.py)  ── holds ──▶ Haiku (haiku.py)
                                      │  add / draw / count
                                      ▼
                                   storage.save()  ──writes──▶ haiku-jar.json
```

## Components

| Component | Lives in | Responsibility | Talks to |
|-----------|----------|----------------|----------|
| Command line | `src/haiku_jar/cli.py` | Parse argv, dispatch a subcommand, print results | storage, core |
| Jar | `src/haiku_jar/jar.py` | Hold haiku; add, draw at random, count | Haiku |
| Haiku | `src/haiku_jar/haiku.py` | A frozen three-line value object; estimate its shape | (stdlib only) |
| Storage | `src/haiku_jar/storage.py` | Load/save the jar as JSON; resolve the file path | Jar, Haiku |

## Data Flow

`haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho`

1. `cli._cmd_add` splits the text on `/` (`_parse_lines`) into three lines.
2. It builds a `Haiku`, then `storage.load()` reads the current jar from disk.
3. `Jar.add()` appends the new haiku and `storage.save()` writes the jar back.
4. `haiku-jar draw` later calls `Jar.draw()`, which returns a random haiku, or
   raises `EmptyJarError` if the jar is empty.

## Key Decisions & Constraints

- **Standard library only.** No runtime dependencies, so the program runs with a
  bare Python install and stays trivially portable.
- **Randomness is injectable.** `Jar.draw(rng=...)` accepts a `random.Random` so a
  draw can be made repeatable in tests instead of being mocked.
- **The jar file is plain JSON.** Easy to read, diff, and edit by hand; the path is
  configurable through `HAIKU_JAR_PATH`.
