"""Reading the jar from, and writing it to, a small JSON file.

The on-disk shape is a plain list of objects: ``{"lines": [...], "author": ...}``.
A missing file is simply an empty jar, so first runs need no setup.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from haiku_jar.haiku import Haiku
from haiku_jar.jar import Jar

ENV_VAR = "HAIKU_JAR_PATH"
DEFAULT_PATH = Path("haiku-jar.json")


def default_path() -> Path:
    """Where the jar lives: ``$HAIKU_JAR_PATH`` if set, else ./haiku-jar.json."""
    override = os.environ.get(ENV_VAR)
    return Path(override) if override else DEFAULT_PATH


def load(path: Path | None = None) -> Jar:
    """Read a jar from ``path``. A missing file yields an empty jar."""
    path = path or default_path()
    if not path.exists():
        return Jar()
    raw = json.loads(path.read_text(encoding="utf-8"))
    return Jar(Haiku(lines=tuple(item["lines"]), author=item.get("author")) for item in raw)


def save(jar: Jar, path: Path | None = None) -> None:
    """Write ``jar`` to ``path`` as pretty-printed JSON."""
    path = path or default_path()
    payload = [{"lines": list(h.lines), "author": h.author} for h in jar]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
