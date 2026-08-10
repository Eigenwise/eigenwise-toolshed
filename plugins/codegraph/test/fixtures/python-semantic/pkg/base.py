from pathlib import Path


class Base:
    stable = 1

    def run(self) -> str:
        return "base"


def external_path() -> Path:
    return Path(".")
