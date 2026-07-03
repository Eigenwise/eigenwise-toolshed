"""Let ``python -m haiku_jar`` run the command line too."""

from haiku_jar.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
