"""Tests for the haiku, the jar, the storage round-trip, and the CLI."""

from __future__ import annotations

import random

import pytest

from haiku_jar.cli import main
from haiku_jar.haiku import Haiku
from haiku_jar.jar import EmptyJarError, Jar
from haiku_jar.storage import load, save

BASHO = Haiku(
    lines=("old pond", "a frog leaps in", "the sound of water"),
    author="Basho",
)


def test_haiku_requires_three_lines() -> None:
    with pytest.raises(ValueError):
        Haiku(lines=("only", "two"))  # type: ignore[arg-type]


def test_well_formed_is_advisory() -> None:
    tidy = Haiku(
        lines=("an old silent pond", "a frog jumps into the pond", "splash, silence again")
    )
    assert tidy.is_well_formed()
    assert not Haiku(lines=("one", "two", "three")).is_well_formed()


def test_draw_is_repeatable_with_a_seed() -> None:
    jar = Jar([BASHO, Haiku(lines=("a", "b", "c")), Haiku(lines=("x", "y", "z"))])
    assert jar.draw(random.Random(0)) == jar.draw(random.Random(0))


def test_draw_from_empty_jar_raises() -> None:
    with pytest.raises(EmptyJarError):
        Jar().draw()


def test_storage_round_trip(tmp_path) -> None:
    path = tmp_path / "jar.json"
    save(Jar([BASHO]), path)
    restored = load(path)
    assert len(restored) == 1
    assert restored.all()[0] == BASHO


def test_missing_file_is_an_empty_jar(tmp_path) -> None:
    assert len(load(tmp_path / "nope.json")) == 0


def test_cli_add_then_count(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("HAIKU_JAR_PATH", str(tmp_path / "jar.json"))
    assert (
        main(["add", "old pond / a frog leaps in / the sound of water", "--author", "Basho"]) == 0
    )
    assert main(["count"]) == 0
    assert capsys.readouterr().out.strip().endswith("1")
