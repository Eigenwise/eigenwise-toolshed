export class UsageError extends Error {}

export function parseFlags(argv, { valueFlags, booleanFlags }) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (booleanFlags.includes(flag)) {
      values[flag.slice(2)] = true;
    } else if (valueFlags.includes(flag)) {
      index += 1;
      values[flag.slice(2)] = requireValue(flag, argv[index]);
    } else {
      throw new UsageError(`unknown argument ${flag}`);
    }
  }
  return values;
}

function requireValue(flag, value) {
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}
