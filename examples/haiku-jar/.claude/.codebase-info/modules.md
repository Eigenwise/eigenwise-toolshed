# Key Modules

*Last Updated: 2026-06-26*

### haiku
- **Location:** `src/haiku_jar/haiku.py`
- **Purpose:** The `Haiku` value object: three lines and an optional author, plus a
  loose 5-7-5 self-check.
- **Key files:** `haiku.py`
- **Depends on:** standard library only (`dataclasses`, `re`)
- **Exposes:** `Haiku` (frozen dataclass), `estimate_syllables(line)`. `Haiku.shape`
  estimates each line's syllables; `Haiku.is_well_formed()` is advisory, never
  enforced.

### jar
- **Location:** `src/haiku_jar/jar.py`
- **Purpose:** The `Jar` collection that holds haiku and gives one back.
- **Key files:** `jar.py`
- **Depends on:** `haiku`
- **Exposes:** `Jar` (`add`, `draw`, `all`, `__len__`, `__iter__`) and
  `EmptyJarError`. `draw(rng=...)` takes an optional `random.Random` for repeatable
  draws.

### storage
- **Location:** `src/haiku_jar/storage.py`
- **Purpose:** Persist the jar to, and load it from, a JSON file.
- **Key files:** `storage.py`
- **Depends on:** `jar`, `haiku`
- **Exposes:** `load(path)`, `save(jar, path)`, `default_path()`, the `ENV_VAR`
  (`HAIKU_JAR_PATH`) and `DEFAULT_PATH` constants.

### cli
- **Location:** `src/haiku_jar/cli.py`
- **Purpose:** The argparse command line that ties everything together.
- **Key files:** `cli.py`, `__main__.py`
- **Depends on:** `storage`, `jar`, `haiku`
- **Exposes:** `main(argv)`, `build_parser()`, and the `_cmd_*` subcommand handlers.
