from pkg import exported

result = exported()
dynamic = getattr(result, "missing")
