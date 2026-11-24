const DATABASE_WARNING_TEXT = "SQLite is an experimental feature";

const isDatabaseModuleWarning = (warning, type) => type === "ExperimentalWarning" && String(warning).includes(DATABASE_WARNING_TEXT);

// The runtime announces the database module through process.emitWarning while it loads, so only that call is wrapped,
// only for the length of the load, and only that one warning is dropped. Every other warning goes to the original.
export function loadWithoutDatabaseModuleWarning(load) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!isDatabaseModuleWarning(warning, rest[0])) emitWarning.call(process, warning, ...rest);
  };
  try {
    return load();
  } finally {
    process.emitWarning = emitWarning;
  }
}
