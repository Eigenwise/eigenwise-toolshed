"""The Haiku: three lines, and a loose sense of their own measure.

The 5-7-5 check counts vowel groups, which is only an approximation of English
syllables. It is advisory, never enforced; a jar will keep any three lines you
give it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_VOWEL_RUN = re.compile(r"[aeiouy]+", re.IGNORECASE)
_CANONICAL_SHAPE = (5, 7, 5)


def estimate_syllables(line: str) -> int:
    """Estimate the syllables in a line by counting runs of vowels.

    Rough but cheerful: 'the sound of water' counts the vowel runs, not the truth.
    """
    return len(_VOWEL_RUN.findall(line))


@dataclass(frozen=True)
class Haiku:
    """Three lines and, optionally, the hand that wrote them."""

    lines: tuple[str, str, str]
    author: str | None = None

    def __post_init__(self) -> None:
        if len(self.lines) != 3:
            raise ValueError("a haiku is three lines, no more and no less")

    @property
    def shape(self) -> tuple[int, int, int]:
        """The estimated syllable count of each line."""
        a, b, c = (estimate_syllables(line) for line in self.lines)
        return (a, b, c)

    def is_well_formed(self) -> bool:
        """True when the shape is close to the canonical 5-7-5 (within one each)."""
        return all(
            abs(got - want) <= 1 for got, want in zip(self.shape, _CANONICAL_SHAPE, strict=True)
        )

    def __str__(self) -> str:
        body = "\n".join(self.lines)
        return f"{body}\n    by {self.author}" if self.author else body
