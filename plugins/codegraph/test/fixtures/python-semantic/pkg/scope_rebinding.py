counter = 0


def bump() -> None:
    global counter
    counter += 1


def enclosing() -> None:
    value = 0

    def increment() -> None:
        nonlocal value
        value += 1

    increment()
