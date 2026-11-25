import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// The facts hooks/board-root.ts reads from a bare repository, as real git gives them: every worktree reports the same
// common folder, it is not a `.git` folder, and its own config says bare.
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commonFolderOf = (cwd) => git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");

const BARE_SETTING = /^\s*bare\s*=\s*true\s*$/im;
const ORDINARY_GIT_FOLDER = /[\\/]\.git$/;

describe("a bare repository with two worktrees", () => {
  let scratch;
  const folder = (name) => join(scratch, name);

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "sidequest-bare-"));
    git(scratch, "init", "-q", "-b", "main", "origin");
    git(folder("origin"), "commit", "-q", "--allow-empty", "-m", "first");
    git(scratch, "clone", "-q", "--bare", "origin", "uploads.git");
    git(folder("uploads.git"), "worktree", "add", "-q", "../wt1", "main");
    git(folder("uploads.git"), "worktree", "add", "-q", "-b", "other", "../wt2", "main");
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("both worktrees report one common folder that is not a .git folder", () => {
    const first = commonFolderOf(folder("wt1"));
    const second = commonFolderOf(folder("wt2"));

    assert.equal(first, second);
    assert.match(first, /uploads\.git$/);
    assert.equal(ORDINARY_GIT_FOLDER.test(first), false);
  });

  test("the common folder's config says bare, and an ordinary repository's does not", () => {
    assert.match(readFileSync(join(commonFolderOf(folder("wt1")), "config"), "utf8"), BARE_SETTING);
    assert.doesNotMatch(readFileSync(join(commonFolderOf(folder("origin")), "config"), "utf8"), BARE_SETTING);
    assert.equal(ORDINARY_GIT_FOLDER.test(commonFolderOf(folder("origin"))), true);
  });
});
