from pathlib import Path

from .base import Base


def replace_run(self: Base) -> str:
    return "patched"


setattr(Base, "run", replace_run)


def patched_call() -> str:
    return Base().run()


def computed(target: object) -> object:
    return getattr(target, "run")()


def dynamic_import(name: str) -> object:
    return __import__(name)


def external_path() -> Path:
    return Path(".")


def missing() -> object:
    return unknown_target()


def decorate(function):
    return function


class Meta(type):
    pass


class Uncertain(Base, metaclass=Meta):
    @decorate
    def run(self) -> str:
        return "uncertain"


if condition:
    from .a import target
else:
    from .b import target


def conditional_target() -> str:
    return target()
