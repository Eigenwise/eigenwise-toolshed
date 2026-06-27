"""The Jar: it holds the haiku, and gives one back when asked.

The jar is just an in-memory list with manners. Persistence lives next door in
``storage.py``; drawing at random lives here.
"""

from __future__ import annotations

import random
from collections.abc import Iterable, Iterator

from haiku_jar.haiku import Haiku


class EmptyJarError(Exception):
    """Raised when you reach into a jar that holds no haiku."""


class Jar:
    """A small collection of haiku you can add to, draw from, and count."""

    def __init__(self, haiku: Iterable[Haiku] | None = None) -> None:
        self._haiku: list[Haiku] = list(haiku or [])

    def add(self, haiku: Haiku) -> None:
        """Drop one haiku into the jar."""
        self._haiku.append(haiku)

    def draw(self, rng: random.Random | None = None) -> Haiku:
        """Take a haiku back out at random, leaving the jar unchanged.

        Pass ``rng`` to make the draw repeatable; tests do exactly that.
        """
        if not self._haiku:
            raise EmptyJarError("the jar is empty; add a haiku first")
        chooser = rng or random
        return chooser.choice(self._haiku)

    def all(self) -> list[Haiku]:
        """Every haiku in the jar, in the order they were added."""
        return list(self._haiku)

    def __len__(self) -> int:
        return len(self._haiku)

    def __iter__(self) -> Iterator[Haiku]:
        return iter(self._haiku)
