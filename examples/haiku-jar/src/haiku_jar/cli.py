"""The command line that ties the knot.

    haiku-jar add "old pond / a frog leaps in / the sound of water" --author Basho
    haiku-jar draw
    haiku-jar list
    haiku-jar count

Built on argparse, so there is nothing to install. The jar file defaults to
./haiku-jar.json (override with $HAIKU_JAR_PATH).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from haiku_jar import __version__
from haiku_jar.haiku import Haiku
from haiku_jar.jar import EmptyJarError
from haiku_jar.storage import load, save


def _parse_lines(text: str) -> tuple[str, str, str]:
    parts = [segment.strip() for segment in text.split("/")]
    if len(parts) != 3 or not all(parts):
        raise ValueError('a haiku needs three non-empty lines separated by "/"')
    return (parts[0], parts[1], parts[2])


def _cmd_add(args: argparse.Namespace) -> int:
    haiku = Haiku(lines=_parse_lines(args.text), author=args.author)
    jar = load()
    jar.add(haiku)
    save(jar)
    note = "" if haiku.is_well_formed() else "  (its shape wanders from 5-7-5)"
    print(f"Added. The jar now holds {len(jar)} haiku.{note}")
    return 0


def _cmd_draw(args: argparse.Namespace) -> int:
    try:
        haiku = load().draw()
    except EmptyJarError as exc:
        print(exc, file=sys.stderr)
        return 1
    print(haiku)
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    jar = load()
    for index, haiku in enumerate(jar, start=1):
        print(f"{index}. {' / '.join(haiku.lines)}")
    print(f"({len(jar)} in the jar)")
    return 0


def _cmd_count(args: argparse.Namespace) -> int:
    print(len(load()))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="haiku-jar", description="Keep and draw haiku.")
    parser.add_argument("--version", action="version", version=f"haiku-jar {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help='add a haiku ("line / line / line")')
    add.add_argument("text", help='the three lines, separated by "/"')
    add.add_argument("--author", default=None, help="who wrote it")
    add.set_defaults(func=_cmd_add)

    draw = sub.add_parser("draw", help="draw a haiku at random")
    draw.set_defaults(func=_cmd_draw)

    listing = sub.add_parser("list", help="list every haiku in the jar")
    listing.set_defaults(func=_cmd_list)

    count = sub.add_parser("count", help="count the haiku in the jar")
    count.set_defaults(func=_cmd_count)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
