import sys


def after_raise() -> int:
    raise NotImplementedError
    value_after_raise = 1
    return value_after_raise


def after_return() -> int:
    return 1
    value_after_return = 2
    print(value_after_return)


if sys.version_info >= (3, 99):
    marker = 1
else:
    marker = 2

print(marker)
