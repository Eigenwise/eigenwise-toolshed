import "./_temp-cleanup.js";
import "./_sidequest-install-fixture.js";
import "./_hook-runtime.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sq-evidence-routing-home-"));
process.env.SIDEQUEST_HOME = home;
const store = require("../lib/store.js");
const { STARTER_ROUTING_PROFILES } = require("../lib/category-defaults.js");
const repository = fs.mkdtempSync(path.join(os.tmpdir(), "sq-evidence-routing-repo-"));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sq-evidence-routing-data-"));
const { slug } = store.ensureProject(repository);

test("evidence category is seeded on Coding and Research with its provenance contract", () => {
  for (const id of ["coding", "research"]) {
    const category = STARTER_ROUTING_PROFILES.find((profile: { id: string }) => profile.id === id).categories.find((category: { id: string }) => category.id === "research.evidence");
    assert.equal(category.readonly, true);
    assert.equal(category.writes, "evidence");
    assert.deepEqual(category.route, { model: "sonnet", effort: "medium" });
    assert.deepEqual(category.fallback, { model: "opus", effort: "high" });
    assert.match(category.contract, /sha256/);
    assert.match(category.contract, /checkpoint with a cursor/);
  }
});

test("evidence category normalizer preserves its evidence write authority", () => {
  const category = store.getCategory("research.evidence", { project: slug });
  assert.equal(category.writes, "evidence");
  assert.equal(category.readonly, true);
});

test("investigationDataRoots accepts existing external paths and normalizes duplicates", () => {
  assert.equal(store.setBoardConfig(slug, { investigationDataRoots: [dataRoot, path.join(dataRoot, ".")] }).ok, true);
  assert.deepEqual(store.boardConfig(slug).investigationDataRoots, [require("../lib/kernel/worktree.js").canonicalPath(dataRoot)]);
});

test("investigationDataRoots refuses a repository internal root", () => {
  assert.throws(() => store.setBoardConfig(slug, { investigationDataRoots: [repository] }), /outside the repository/);
});

test("investigationDataRoots refuses a missing absolute path", () => {
  assert.throws(() => store.setBoardConfig(slug, { investigationDataRoots: [path.join(dataRoot, "missing")] }), /does not exist/);
});

test("investigationDataRoots refuses relative paths and non-array input", () => {
  assert.throws(() => store.setBoardConfig(slug, { investigationDataRoots: ["relative"] }), /absolute paths/);
  assert.throws(() => store.setBoardConfig(slug, { investigationDataRoots: dataRoot }), /array/);
});

export {};
