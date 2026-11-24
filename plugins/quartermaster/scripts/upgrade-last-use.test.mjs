import assert from "node:assert/strict";
import { test } from "node:test";

import { wasUsedWithin, lastUseOf, lastUseWords, olderProjectCountLine, orderedByLastUse } from "./upgrade-last-use.mjs";

const DAY = 24 * 60 * 60 * 1000;
const nowMs = Date.UTC(2026, 10, 20);

test("the newer of a session and a commit is the last use, a commit alone over nothing", () => {
  assert.deepEqual(lastUseOf(9, 5), { atMs: 9, source: "session" });
  assert.deepEqual(lastUseOf(5, 9), { atMs: 9, source: "commit" });
  assert.deepEqual(lastUseOf(undefined, 9), { atMs: 9, source: "commit" });
  assert.equal(lastUseOf(undefined, undefined), undefined);
});

test("a session or a commit inside the window counts as used", () => {
  assert.equal(wasUsedWithin({ atMs: nowMs - 29 * DAY, source: "session" }, nowMs, 30), true);
  assert.equal(wasUsedWithin({ atMs: nowMs - 31 * DAY, source: "session" }, nowMs, 30), false);
  assert.equal(wasUsedWithin({ atMs: nowMs - DAY, source: "commit" }, nowMs, 30), true);
  assert.equal(wasUsedWithin({ atMs: nowMs - 31 * DAY, source: "commit" }, nowMs, 30), false);
  assert.equal(wasUsedWithin(undefined, nowMs, 30), false);
});

test("orders the newest first and projects with nothing on record last", () => {
  const ordered = orderedByLastUse([{ id: "none" }, { id: "old", lastUse: { atMs: 1 } }, { id: "new", lastUse: { atMs: 2 } }]);
  assert.deepEqual(ordered.map((project) => project.id), ["new", "old", "none"]);
});

test("says the date and the source, or that nothing is on record", () => {
  assert.equal(lastUseWords({ atMs: Date.UTC(2026, 9, 6), source: "session" }), "last used 2026-10-06 (session)");
  assert.equal(lastUseWords({ atMs: Date.UTC(2026, 9, 6), source: "commit" }), "last used 2026-10-06 (commit)");
  assert.equal(lastUseWords(undefined), "no session or commit on record");
});

test("the count line separates installed, switched on in settings and used lately", () => {
  const others = [
    { olderPluginsOn: ["sidequest"], lastUse: { atMs: nowMs - DAY, source: "session" } },
    { olderPluginsOn: ["sidequest"], lastUse: { atMs: nowMs - 90 * DAY, source: "commit" } },
    { olderPluginsOn: [], lastUse: { atMs: nowMs - DAY, source: "session" } },
  ];
  assert.equal(
    olderProjectCountLine(others, nowMs),
    "Other projects: 3 have the older version installed. 2 still have a plugin of it switched on in their settings; 1 of those were used in the last 30 days. --all-projects lists them, most recently used first.",
  );
});
