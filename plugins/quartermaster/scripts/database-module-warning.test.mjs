import assert from "node:assert/strict";
import { test } from "node:test";

import { loadWithoutDatabaseModuleWarning } from "./database-module-warning.mjs";

const DATABASE_WARNING = "SQLite is an experimental feature and might change at any time";

function collectWarningsDuring(action) {
  const messages = [];
  const listener = (warning) => messages.push(`${warning.name}: ${warning.message}`);
  process.on("warning", listener);
  action();
  return new Promise((resolve) => {
    setImmediate(() => {
      process.off("warning", listener);
      resolve(messages);
    });
  });
}

test("hides the database module's experimental warning and returns what the loader returns", async () => {
  let loaded;
  const messages = await collectWarningsDuring(() => {
    loaded = loadWithoutDatabaseModuleWarning(() => {
      process.emitWarning(DATABASE_WARNING, "ExperimentalWarning");
      return "the module";
    });
  });
  assert.equal(loaded, "the module");
  assert.deepEqual(messages, []);
});

test("lets every other warning through, even another experimental one", async () => {
  const messages = await collectWarningsDuring(() => {
    loadWithoutDatabaseModuleWarning(() => {
      process.emitWarning("Another feature is experimental", "ExperimentalWarning");
      process.emitWarning("something else", "DeprecationWarning");
    });
  });
  assert.deepEqual(messages, ["ExperimentalWarning: Another feature is experimental", "DeprecationWarning: something else"]);
});

test("puts the warning function back, also when the loader throws", async () => {
  const original = process.emitWarning;
  assert.throws(() => loadWithoutDatabaseModuleWarning(() => { throw new Error("cannot load"); }), /cannot load/);
  assert.equal(process.emitWarning, original);
  const messages = await collectWarningsDuring(() => process.emitWarning(DATABASE_WARNING, "ExperimentalWarning"));
  assert.deepEqual(messages, [`ExperimentalWarning: ${DATABASE_WARNING}`]);
});
