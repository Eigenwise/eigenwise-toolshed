import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { isInside, keepReasonsOf, parseWorktreeList, takeAwayLinksIntoMainCheckout } from "./worktrees.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "worktrees.mjs");
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const runScript = (cwd, ...args) => JSON.parse(execFileSync(process.execPath, [scriptPath, ...args, "--json"], { cwd, env: gitEnvironment, encoding: "utf8" }));

const commitFile = (folder, name, text) => {
  writeFileSync(join(folder, name), text);
  git(folder, "add", name);
  git(folder, "commit", "-q", "-m", `add ${name}`);
};

function makeScratchRepository() {
  const scratch = mkdtempSync(join(tmpdir(), "sidequest-worktrees-"));
  const remote = join(scratch, "remote.git");
  const main = join(scratch, "main");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  commitFile(main, ".gitignore", "linked\n.claude/\n");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "-u", "origin", "main");
  return { scratch, main };
}

const addWorktree = (main, folder, branch) => {
  git(main, "worktree", "add", "-q", "-b", branch, folder);
  return folder;
};

describe("parseWorktreeList", () => {
  test("reads the main checkout first and each linked worktree's branch, lock and folder", () => {
    const porcelain = [
      "worktree C:/repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree C:/repo-feature with space",
      "HEAD bbb",
      "branch refs/heads/feature/x",
      "locked in use",
      "",
      "worktree C:/gone",
      "HEAD ccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\r\n");
    const [main, feature, gone] = parseWorktreeList(porcelain);
    assert.equal(main.branch, "main");
    assert.equal(feature.path, resolve("C:/repo-feature with space"));
    assert.deepEqual([feature.branch, feature.isLocked, feature.isPrunable], ["feature/x", true, false]);
    assert.deepEqual([gone.branch, gone.isLocked, gone.isPrunable], ["", false, true]);
  });
});

describe("keepReasonsOf", () => {
  const clean = { isFolderMissing: false, isWhereThisRuns: false, hasUnreadableStatus: false, hasUncommittedFiles: false, ignoredOnlyHere: [], commitsOnlyHere: 0, isLocked: false };

  test("finds nothing to keep for a clean worktree with nothing only here", () => {
    assert.deepEqual(keepReasonsOf(clean, "main"), []);
  });

  test("names every reason in plain words", () => {
    const reasons = keepReasonsOf({ ...clean, hasUncommittedFiles: true, commitsOnlyHere: 2, isLocked: true }, "main");
    assert.deepEqual(reasons, ["it has uncommitted or untracked files", "2 commits on no remote and not merged into main", "it is locked"]);
  });

  test("keeps a worktree it could not count", () => {
    assert.deepEqual(keepReasonsOf({ ...clean, commitsOnlyHere: null }, "main"), ["git could not count its commits"]);
  });
});

test("isInside takes the folder itself and what is under it, and nothing beside it", () => {
  assert.equal(isInside(resolve("/repo/a/b"), resolve("/repo")), true);
  assert.equal(isInside(resolve("/repo"), resolve("/repo")), true);
  assert.equal(isInside(resolve("/repo-other"), resolve("/repo")), false);
});

describe("worktrees in every state", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    const agentFolder = join(main, ".claude", "worktrees");

    const pushed = addWorktree(main, join(scratch, "pushed"), "pushed");
    commitFile(pushed, "pushed.txt", "pushed\n");
    git(pushed, "push", "-q", "-u", "origin", "pushed");

    const merged = addWorktree(main, join(agentFolder, "agent-merged"), "merged");
    commitFile(merged, "merged.txt", "merged\n");
    git(main, "merge", "-q", "--ff-only", "merged");

    const dirty = addWorktree(main, join(scratch, "dirty"), "dirty");
    writeFileSync(join(dirty, "notes.txt"), "not committed\n");

    const unpushed = addWorktree(main, join(agentFolder, "agent-unpushed"), "unpushed");
    commitFile(unpushed, "unpushed.txt", "only here\n");

    const locked = addWorktree(main, join(scratch, "locked"), "locked");
    git(main, "worktree", "lock", "--reason", "in use", locked);

    folders = { pushed, merged, dirty, unpushed, locked };
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const verdictsByBranch = (report) => Object.fromEntries(report.worktrees.map((worktree) => [worktree.branch, worktree]));

  test("each gets the right verdict", () => {
    const verdicts = verdictsByBranch(runScript(repository.main));
    assert.equal(verdicts.pushed.verdict, "safe");
    assert.equal(verdicts.merged.verdict, "safe");
    assert.deepEqual(verdicts.dirty.reasons, ["it has uncommitted or untracked files"]);
    assert.equal(verdicts.dirty.hasUncommittedFiles, true);
    assert.deepEqual(verdicts.unpushed.reasons, ["1 commit on no remote and not merged into main"]);
    assert.equal(verdicts.unpushed.commitsOnlyHere, 1);
    assert.deepEqual(verdicts.locked.reasons, ["it is locked"]);
    assert.match(verdicts.locked.lastCommit, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("--remove-safe --named removes exactly the pushed and the merged ones and keeps the rest with a reason", () => {
    const report = runScript(repository.main, "--remove-safe", "--named");
    const removed = report.removals.map((removal) => [removal.branch, removal.isRemoved]).sort();
    assert.deepEqual(removed, [["merged", true], ["pushed", true]]);
    assert.equal(existsSync(folders.pushed), false);
    assert.equal(existsSync(folders.merged), false);
    for (const kept of [folders.dirty, folders.unpushed, folders.locked]) assert.equal(existsSync(kept), true);
    const branches = git(repository.main, "branch", "--format=%(refname:short)").split("\n");
    assert.equal(branches.includes("merged"), false);
    assert.equal(branches.includes("unpushed"), true);

    const after = verdictsByBranch(runScript(repository.main));
    assert.deepEqual(Object.keys(after).sort(), ["dirty", "locked", "unpushed"]);
    assert.ok(Object.values(after).every((worktree) => worktree.verdict === "keep" && worktree.reasons.length > 0));
  });

  test("the plain table names each worktree and its verdict", () => {
    const table = execFileSync(process.execPath, [scriptPath], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
    assert.match(table, /keep: it is locked/);
    assert.match(table, /3 linked worktrees: 0 safe to remove, 3 to keep\./);
  });
});

describe("a link into the main checkout", () => {
  let repository;

  before(() => {
    repository = makeScratchRepository();
    mkdirSync(join(repository.main, "shared"));
    writeFileSync(join(repository.main, "shared", "data.txt"), "keep me\n");
    writeFileSync(join(repository.main, "shared", "more.txt"), "and me\n");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  // On Windows a directory junction needs no special rights. Elsewhere the type is ignored and a symbolic link is made.
  const linkIntoMainCheckout = (worktree) => symlinkSync(join(repository.main, "shared"), join(worktree, "linked"), "junction");

  test("is taken away as a link and its target is left alone", () => {
    const worktree = addWorktree(repository.main, join(repository.scratch, "linked-direct"), "linked-direct");
    linkIntoMainCheckout(worktree);
    writeFileSync(join(worktree, "own.txt"), "own\n");

    assert.deepEqual(takeAwayLinksIntoMainCheckout(worktree, repository.main), [join(worktree, "linked")]);
    assert.equal(existsSync(join(worktree, "linked")), false);
    assert.equal(existsSync(join(worktree, "own.txt")), true);
    assert.equal(existsSync(join(repository.main, "shared", "data.txt")), true);
  });

  test("survives --remove-safe with every file behind it still there", () => {
    const worktree = addWorktree(repository.main, join(repository.scratch, "linked-removed"), "linked-removed");
    linkIntoMainCheckout(worktree);

    const report = runScript(repository.main, "--remove-safe", "--named");
    const removal = report.removals.find((one) => one.branch === "linked-removed");
    assert.ok(removal, JSON.stringify(report.worktrees.map((worktree) => [worktree.branch, worktree.reasons])));
    assert.equal(removal.isRemoved, true);
    assert.equal(existsSync(worktree), false);
    assert.equal(existsSync(join(repository.main, "shared", "data.txt")), true);
    assert.equal(existsSync(join(repository.main, "shared", "more.txt")), true);
    assert.equal(removal.linksTakenAway.length, 1);
  });
});

describe("agent branches with no worktree", () => {
  let repository;

  before(() => {
    repository = makeScratchRepository();
    const { main } = repository;
    git(main, "branch", "worktree-agent-untouched");
    git(main, "checkout", "-q", "-b", "worktree-agent-merged");
    commitFile(main, "merged.txt", "merged\n");
    git(main, "checkout", "-q", "main");
    git(main, "merge", "-q", "--ff-only", "worktree-agent-merged");
    git(main, "checkout", "-q", "-b", "worktree-agent-own-work");
    commitFile(main, "first.txt", "first\n");
    commitFile(main, "second.txt", "second\n");
    git(main, "checkout", "-q", "main");
    git(main, "branch", "ordinary-branch");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const branchVerdictsOf = (report) => Object.fromEntries(report.branches.map((branch) => [branch.branch, branch]));
  const branchNames = () => git(repository.main, "branch", "--format=%(refname:short)").split("\n");

  test("lists merged and untouched ones safe and one with its own commits keep with the count", () => {
    const verdicts = branchVerdictsOf(runScript(repository.main));
    assert.deepEqual(Object.keys(verdicts).sort(), ["worktree-agent-merged", "worktree-agent-own-work", "worktree-agent-untouched"]);
    assert.equal(verdicts["worktree-agent-merged"].verdict, "safe");
    assert.equal(verdicts["worktree-agent-untouched"].verdict, "safe");
    assert.deepEqual(verdicts["worktree-agent-own-work"].reasons, ["2 commits not merged into main"]);
  });

  test("changes nothing until --remove-safe", () => {
    assert.equal(branchNames().includes("worktree-agent-merged"), true);
  });

  test("--remove-safe deletes the safe ones and never the keep", () => {
    const report = runScript(repository.main, "--remove-safe");
    assert.deepEqual(report.branchRemovals.map((removal) => removal.isDeleted), [true, true]);
    const names = branchNames();
    assert.equal(names.includes("worktree-agent-merged"), false);
    assert.equal(names.includes("worktree-agent-untouched"), false);
    assert.equal(names.includes("worktree-agent-own-work"), true);
    assert.equal(names.includes("ordinary-branch"), true);
  });
});

describe("hundreds of safe agent branches", () => {
  let repository;

  before(() => {
    repository = makeScratchRepository();
    const head = git(repository.main, "rev-parse", "HEAD");
    const updates = Array.from({ length: 300 }, (_, index) => `create refs/heads/worktree-agent-${String(index).padStart(4, "0")} ${head}\n`).join("");
    execFileSync("git", ["update-ref", "--stdin"], { cwd: repository.main, env: gitEnvironment, input: updates });
    git(repository.main, "checkout", "-q", "-b", "worktree-agent-with-work");
    commitFile(repository.main, "work.txt", "work\n");
    git(repository.main, "checkout", "-q", "main");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  test("print as one count line with the keep named", () => {
    const text = execFileSync(process.execPath, [scriptPath], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
    assert.match(text, /301 agent branches with no worktree: 300 safe to remove, 1 to keep\./);
    assert.match(text, /keep worktree-agent-with-work: 1 commit not merged into main/);
    assert.equal(text.includes("worktree-agent-0001"), false);
  });

  test("--remove-safe reports one count line for the deletions", () => {
    const text = execFileSync(process.execPath, [scriptPath, "--remove-safe"], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
    assert.match(text, /deleted 300 branches/);
    assert.equal(git(repository.main, "branch", "--list", "worktree-agent-*").trim(), "worktree-agent-with-work");
  });
});

describe("a safe worktree whose name a person chose", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    const agentFolder = join(main, ".claude", "worktrees");
    const releaseNotes = addWorktree(main, join(scratch, "release-notes"), "release-notes");
    commitFile(releaseNotes, "notes.txt", "notes\n");
    git(main, "merge", "-q", "--ff-only", "release-notes");
    folders = {
      releaseNotes,
      agentNamed: addWorktree(main, join(agentFolder, "agent-0a1b"), "worktree-agent-0a1b"),
      agentFolderOwnBranch: addWorktree(main, join(agentFolder, "agent-0c2d"), "spike-login"),
    };
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  test("is named in the line before removal, while the agents' safe ones stay a count", () => {
    const text = execFileSync(process.execPath, [scriptPath], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
    assert.match(text, /3 linked worktrees: 3 safe to remove, 0 to keep\./);
    const namedLine = text.split(/\r?\n/).find((line) => line.startsWith("Safe, and named by a person"));
    assert.ok(namedLine, text);
    assert.ok(namedLine.includes("(branch release-notes)"), namedLine);
    assert.ok(namedLine.includes("(branch spike-login)"), namedLine);
    assert.equal(namedLine.includes("worktree-agent-0a1b"), false);
  });

  test("--remove-safe removes the agents' safe one, leaves the ones a person named and says --named removes them", () => {
    const text = execFileSync(process.execPath, [scriptPath, "--remove-safe"], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
    const namedLine = text.split(/\r?\n/).find((line) => line.startsWith("Safe, and named by a person"));
    assert.ok(namedLine?.includes("not removed (--remove-safe --named removes them)"), text);
    assert.equal(existsSync(folders.agentNamed), false);
    assert.equal(existsSync(folders.releaseNotes), true);
    assert.equal(existsSync(folders.agentFolderOwnBranch), true);
  });

  test("--remove-safe --named removes them too", () => {
    const report = runScript(repository.main, "--remove-safe", "--named");
    assert.deepEqual(report.removals.map((removal) => [removal.branch, removal.isRemoved]).sort(), [["release-notes", true], ["spike-login", true]]);
    assert.equal(existsSync(folders.releaseNotes), false);
    assert.equal(existsSync(folders.agentFolderOwnBranch), false);
  });
});

describe("--branch given more than once and --worktree narrow the removal to what land landed", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    const agentFolder = join(main, ".claude", "worktrees");
    git(main, "worktree", "add", "-q", "--detach", join(agentFolder, "land-story"), "main");
    folders = {
      firstLanded: addWorktree(main, join(agentFolder, "agent-first"), "worktree-agent-first"),
      secondLanded: addWorktree(main, join(agentFolder, "agent-second"), "worktree-agent-second"),
      landing: join(agentFolder, "land-story"),
      nextSliceAgent: addWorktree(main, join(agentFolder, "agent-next"), "worktree-agent-next"),
      personsHotfix: addWorktree(main, join(scratch, "my-own-checkout"), "feature/my-own"),
    };
    git(main, "branch", "worktree-agent-other-session");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const branchNames = () => git(repository.main, "branch", "--format=%(refname:short)").split("\n");

  test("only the named branches' worktrees and the named path are judged and removed, person-named or not", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=worktree-agent-first", "--branch=worktree-agent-second", `--worktree=${folders.landing}`);
    assert.equal(report.worktrees.length, 3);
    assert.deepEqual(report.branches, []);
    assert.deepEqual(report.removals.map((removal) => removal.isRemoved), [true, true, true]);
    for (const removed of [folders.firstLanded, folders.secondLanded, folders.landing]) assert.equal(existsSync(removed), false);
    assert.equal(existsSync(folders.nextSliceAgent), true);
    assert.equal(existsSync(folders.personsHotfix), true);
    assert.deepEqual(
      ["worktree-agent-first", "worktree-agent-next", "feature/my-own", "worktree-agent-other-session"].map((branch) => branchNames().includes(branch)),
      [false, true, true, true],
    );
  });

  test("a narrowed call removes a person-named worktree it names without --named", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=feature/my-own");
    assert.deepEqual(report.removals.map((removal) => [removal.branch, removal.isRemoved]), [["feature/my-own", true]]);
    assert.equal(existsSync(folders.personsHotfix), false);
  });
});

describe("ignored files in a worktree", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { main } = repository;
    commitFile(main, ".gitignore", "linked\n.claude/\n.env\n*.db\nbuild/\nlocal-data/\n");
    mkdirSync(join(main, "data"));
    commitFile(join(main, "data"), "README", "data folder\n");
    writeFileSync(join(main, ".env"), "SECRET=main\n");
    mkdirSync(join(main, "build"));
    writeFileSync(join(main, "build", "out.js"), "main build\n");
    git(main, "push", "-q", "origin", "main");

    const worktree = (name) => addWorktree(main, join(main, ".claude", "worktrees", `agent-${name}`), `worktree-agent-${name}`);
    folders = Object.fromEntries(["env-only-here", "env-edited", "env-copied", "data-file", "folder-only-here", "build-made-again", "many"].map((name) => [name, worktree(name)]));
    writeFileSync(join(folders["env-only-here"], ".env"), "SECRET=only here\n");
    writeFileSync(join(folders["env-edited"], ".env"), "SECRET=edited\n");
    writeFileSync(join(folders["env-copied"], ".env"), "SECRET=main\n");
    writeFileSync(join(folders["data-file"], "data", "local.db"), "rows");
    mkdirSync(join(folders["folder-only-here"], "local-data"));
    writeFileSync(join(folders["folder-only-here"], "local-data", "app.db"), "rows");
    mkdirSync(join(folders["build-made-again"], "build"));
    writeFileSync(join(folders["build-made-again"], "build", "out.js"), "a different build\n");
    writeFileSync(join(folders.many, ".env"), "SECRET=many\n");
    for (const name of ["a", "b", "c"]) writeFileSync(join(folders.many, "data", `${name}.db`), name);
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const verdictsByFolder = (report) => Object.fromEntries(report.worktrees.map((worktree) => [worktree.path.split(/[\\/]/).pop().replace(/^agent-/, ""), worktree]));

  test("one that exists nowhere else keeps its worktree, named in the reason", () => {
    const verdicts = verdictsByFolder(runScript(repository.main));
    assert.deepEqual(verdicts["env-only-here"].reasons, ["ignored files that are only here: .env"]);
    assert.deepEqual(verdicts["env-edited"].reasons, ["ignored files that are only here: .env"]);
    assert.deepEqual(verdicts["data-file"].reasons, ["ignored files that are only here: data/local.db"]);
    assert.deepEqual(verdicts["folder-only-here"].reasons, ["ignored files that are only here: local-data/"]);
  });

  test("a file the main checkout holds byte for byte and a folder the main checkout has too stay safe", () => {
    const verdicts = verdictsByFolder(runScript(repository.main));
    assert.equal(verdicts["env-copied"].verdict, "safe");
    assert.equal(verdicts["build-made-again"].verdict, "safe");
  });

  test("the reason names up to three paths and counts the rest", () => {
    const verdicts = verdictsByFolder(runScript(repository.main));
    assert.deepEqual(verdicts.many.reasons, ["ignored files that are only here: .env, data/a.db, data/b.db, and 1 more"]);
  });

  test("--remove-safe leaves the worktree and its ignored file in place", () => {
    runScript(repository.main, "--remove-safe");
    assert.equal(existsSync(join(folders["env-only-here"], ".env")), true);
    assert.equal(existsSync(folders["env-copied"]), false);
  });
});

describe("--branch narrows the verdict and the removal to one ticket's run", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;

    const merged = addWorktree(main, join(scratch, "dropped-merged"), "worktree-agent-merged");
    commitFile(merged, "merged.txt", "merged\n");
    git(main, "merge", "-q", "--ff-only", "worktree-agent-merged");

    const unmerged = addWorktree(main, join(scratch, "dropped-unmerged"), "worktree-agent-unmerged");
    commitFile(unmerged, "first.txt", "first\n");
    commitFile(unmerged, "second.txt", "second\n");

    const bystander = addWorktree(main, join(scratch, "bystander"), "worktree-agent-bystander");
    git(main, "branch", "worktree-agent-other-safe");

    folders = { merged, unmerged, bystander };
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const branchNames = () => git(repository.main, "branch", "--format=%(refname:short)").split("\n");

  test("a merged branch with a clean worktree loses both, and nothing else is touched", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=worktree-agent-merged");
    assert.deepEqual(report.worktrees.map((worktree) => worktree.branch), ["worktree-agent-merged"]);
    assert.deepEqual(report.branches, []);
    assert.deepEqual(report.removals.map((removal) => [removal.branch, removal.isRemoved, removal.branchDeletion.isDeleted]), [["worktree-agent-merged", true, true]]);
    assert.equal(existsSync(folders.merged), false);
    assert.equal(existsSync(folders.bystander), true);
    assert.equal(branchNames().includes("worktree-agent-merged"), false);
    assert.equal(branchNames().includes("worktree-agent-other-safe"), true);
  });

  test("a branch with unmerged commits loses its worktree and keeps the branch with the reason", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=worktree-agent-unmerged");
    assert.deepEqual(report.removals.map((removal) => [removal.isRemoved, removal.branchDeletion]), [
      [true, { isDeleted: false, reason: "no other branch or remote holds its commits" }],
    ]);
    assert.equal(existsSync(folders.unmerged), false);
    assert.equal(branchNames().includes("worktree-agent-unmerged"), true);
  });

  test("a branch with no worktree is judged on its own, and the main branch is never a candidate", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=worktree-agent-other-safe");
    assert.deepEqual(report.branchRemovals.map((removal) => [removal.branch, removal.isDeleted]), [["worktree-agent-other-safe", true]]);
    const main = runScript(repository.main, "--remove-safe", "--branch=main");
    assert.deepEqual([main.worktrees, main.branches], [[], []]);
    assert.equal(branchNames().includes("main"), true);
  });
});

describe("a run branch that stays unmerged for a pull request", () => {
  let repository;
  let folders;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    const agentFolder = join(main, ".claude", "worktrees");
    git(main, "branch", "worktree-agent-host");
    folders = { agent: join(agentFolder, "agent-host"), verify: join(scratch, "verify"), lost: join(scratch, "lost") };
    git(main, "worktree", "add", "-q", "-b", "ticket/run", folders.agent, "worktree-agent-host");
    commitFile(folders.agent, "work.txt", "work\n");
    git(main, "worktree", "add", "-q", "--detach", folders.verify, "ticket/run");
    git(main, "worktree", "add", "-q", "--detach", folders.lost, "main");
    commitFile(folders.lost, "stray.txt", "on no branch\n");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const branchNames = () => git(repository.main, "branch", "--format=%(refname:short)").split("\n");

  test("without --branch or --worktree the verdicts stay as they were", () => {
    const verdicts = Object.fromEntries(runScript(repository.main).worktrees.map((worktree) => [worktree.path.split(/[\\/]/).pop(), worktree.reasons]));
    assert.deepEqual(verdicts["agent-host"], ["1 commit on no remote and not merged into main"]);
    assert.deepEqual(verdicts.verify, ["1 commit on no remote and not merged into main"]);
  });

  test("a detached worktree with a commit no branch holds is still keep when named", () => {
    const report = runScript(repository.main, "--remove-safe", `--worktree=${folders.lost}`);
    assert.deepEqual(report.worktrees.map((worktree) => worktree.reasons), [["1 commit on no remote and not merged into main"]]);
    assert.equal(existsSync(folders.lost), true);
  });

  test("naming the branch and its verify worktree removes both, keeps the branch and deletes the host's leftover branch", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=ticket/run", `--worktree=${folders.verify}`);
    assert.deepEqual(report.removals.map((removal) => removal.isRemoved), [true, true]);
    assert.equal(existsSync(folders.agent), false);
    assert.equal(existsSync(folders.verify), false);
    const agentRemoval = report.removals.find((removal) => removal.branch === "ticket/run");
    assert.deepEqual(agentRemoval.branchDeletion, { isDeleted: false, reason: "no other branch or remote holds its commits" });
    assert.deepEqual([agentRemoval.leftoverBranch, agentRemoval.leftoverBranchDeletion.isDeleted], ["worktree-agent-host", true]);
    assert.equal(branchNames().includes("ticket/run"), true);
    assert.equal(branchNames().includes("worktree-agent-host"), false);
  });
});

describe("a main checkout detached at the run branch for the verify", () => {
  let repository;

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    repository.agent = addWorktree(main, join(scratch, "run"), "ticket/landing");
    commitFile(repository.agent, "work.txt", "work\n");
    git(main, "checkout", "-q", "--detach", "ticket/landing");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  test("--remove-safe --branch removes the worktree and the branch still exists", () => {
    const report = runScript(repository.main, "--remove-safe", "--branch=ticket/landing");
    assert.equal(report.removals[0].isRemoved, true);
    assert.equal(report.removals[0].branchDeletion.isDeleted, false);
    assert.equal(existsSync(repository.agent), false);
    assert.equal(git(repository.main, "branch", "--list", "ticket/landing"), "ticket/landing");
  });
});

describe("worktree folders git no longer knows", () => {
  let repository;
  let folders;

  const forgetWorktree = (name) => rmSync(join(repository.main, ".git", "worktrees", name), { recursive: true, force: true });

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    const root = join(scratch, "home");

    const clean = addWorktree(main, join(root, "project", "clean-folder"), "clean-folder");
    const dirty = addWorktree(main, join(root, "project", "dirty-folder"), "dirty-folder");
    writeFileSync(join(dirty, "uncommitted.txt"), "not in any commit\n");
    const registered = addWorktree(main, join(root, "project", "still-registered"), "still-registered");
    writeFileSync(join(registered, "notes.txt"), "keeps this worktree out of the safe ones\n");
    forgetWorktree("clean-folder");
    forgetWorktree("dirty-folder");
    mkdirSync(join(root, "project", "plain-folder"));
    writeFileSync(join(root, "project", "plain-folder", "notes.txt"), "not a worktree\n");

    folders = { root, clean, dirty, registered };
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  const folderVerdictsOf = (report) => Object.fromEntries(report.folders.map((folder) => [folder.path.split(/[\\/]/).pop(), folder]));

  test("without a root folder none are looked for", () => {
    assert.deepEqual(runScript(repository.main).folders, []);
  });

  test("lists the ones that look like a worktree of this repository, safe or keep with the reason", () => {
    const verdicts = folderVerdictsOf(runScript(repository.main, folders.root));
    assert.deepEqual(Object.keys(verdicts).sort(), ["clean-folder", "dirty-folder"]);
    assert.equal(verdicts["clean-folder"].verdict, "safe");
    assert.deepEqual(verdicts["dirty-folder"].reasons, ["1 file(s) match no commit here, for example uncommitted.txt"]);
  });

  test("--remove-safe removes the safe folder only", () => {
    const report = runScript(repository.main, folders.root, "--remove-safe");
    assert.deepEqual(report.folderRemovals.map((removal) => [removal.path, removal.isRemoved]), [[folders.clean, true]]);
    assert.equal(existsSync(folders.clean), false);
    assert.equal(existsSync(join(folders.dirty, "uncommitted.txt")), true);
    assert.equal(existsSync(folders.registered), true);
    assert.equal(existsSync(join(folders.root, "project", "plain-folder", "notes.txt")), true);
  });

  test("--only-under-root judges and removes no linked worktree outside the root, and still counts its branch as checked out", () => {
    const outside = addWorktree(repository.main, join(repository.scratch, "outside-the-root"), "worktree-agent-outside");
    const insideClean = addWorktree(repository.main, join(folders.root, "project", "registered-clean"), "registered-clean");
    const report = runScript(repository.main, folders.root, "--only-under-root", "--remove-safe", "--named");
    assert.equal(report.isOnlyUnderRoot, true);
    const judged = report.worktrees.map((worktree) => worktree.path.split(/[\\/]/).pop()).sort();
    assert.deepEqual(judged, ["registered-clean", "still-registered"]);
    assert.equal(report.branches.some((branch) => branch.branch === "worktree-agent-outside"), false);
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(insideClean), false);
  });
});

describe("a folder spelled another way, and line endings git converts", () => {
  const scratchFolders = [];
  const forgottenWorktree = (repository, name) => {
    const folder = addWorktree(repository.main, join(repository.scratch, "home", "project", name), name);
    rmSync(join(repository.main, ".git", "worktrees", name), { recursive: true, force: true });
    return folder;
  };
  const namesAndVerdicts = (report) => report.folders.map((folder) => [folder.path.split(/[\\/]/).pop(), folder.verdict]);

  after(() => scratchFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

  test("a repository reached through another spelling of its folder still finds its worktree folders", () => {
    const repository = makeScratchRepository();
    forgottenWorktree(repository, "clean-folder");
    const otherSpelling = `${repository.scratch}-other-spelling`;
    symlinkSync(repository.scratch, otherSpelling, "junction");
    scratchFolders.push(otherSpelling, repository.scratch);

    const report = runScript(join(otherSpelling, "main"), join(otherSpelling, "home"));

    assert.deepEqual(namesAndVerdicts(report), [["clean-folder", "safe"]]);
  });

  test("a checked out file whose line endings git converted is still one the repository holds", () => {
    const repository = makeScratchRepository();
    scratchFolders.push(repository.scratch);
    git(repository.main, "config", "core.autocrlf", "true");
    commitFile(repository.main, "notes.txt", "one\ntwo\n");
    const folder = forgottenWorktree(repository, "converted-folder");
    writeFileSync(join(folder, "notes.txt"), "one\r\ntwo\r\n");

    const report = runScript(repository.main, join(repository.scratch, "home"));

    assert.deepEqual(namesAndVerdicts(report), [["converted-folder", "safe"]]);
  });
});

describe("a branch pushed without an upstream whose remote copy is gone but not pruned", () => {
  let repository;

  before(() => {
    repository = makeScratchRepository();
    const { main } = repository;
    repository.folder = join(main, ".claude", "worktrees", "agent-pushed");
    git(main, "worktree", "add", "-q", "-b", "worktree-agent-pushed", repository.folder);
    commitFile(repository.folder, "pushed.txt", "pushed\n");
    git(main, "push", "-q", "origin", "worktree-agent-pushed");
    git(main, "push", "-q", "origin", "--delete", "worktree-agent-pushed");
    git(main, "update-ref", "refs/remotes/origin/worktree-agent-pushed", "worktree-agent-pushed");
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  test("--remove-safe removes the worktree and keeps the branch with git's own refusal", () => {
    const report = runScript(repository.main, "--remove-safe");
    assert.equal(report.removals[0].isRemoved, true);
    assert.equal(report.removals[0].branchDeletion.isDeleted, false);
    assert.match(report.removals[0].branchDeletion.reason, /not fully merged/);
    assert.equal(git(repository.main, "branch", "--list", "worktree-agent-pushed"), "worktree-agent-pushed");
  });
});

describe("a worktree with an operation in progress", () => {
  let repository;
  const reason = "an operation is in progress there (rebase, merge, cherry-pick, revert or bisect)";

  before(() => {
    repository = makeScratchRepository();
    const { scratch, main } = repository;
    repository.rebasing = join(scratch, "rebasing");
    repository.merging = join(scratch, "merging");
    git(main, "worktree", "add", "-q", "--detach", repository.rebasing, "main");
    commitFile(repository.rebasing, "one.txt", "one\n");
    commitFile(repository.rebasing, "two.txt", "two\n");
    git(repository.rebasing, "branch", "keep-two");
    execFileSync("git", ["rebase", "-i", "main"], { cwd: repository.rebasing, env: { ...gitEnvironment, GIT_SEQUENCE_EDITOR: "sed -i s/^pick/edit/" }, stdio: "ignore" });
    git(main, "worktree", "add", "-q", "--detach", repository.merging, "main");
    commitFile(repository.merging, "clash.txt", "left\n");
    git(main, "branch", "right", "main");
    git(main, "worktree", "add", "-q", join(scratch, "right-side"), "right");
    commitFile(join(scratch, "right-side"), "clash.txt", "right\n");
    try {
      git(repository.merging, "merge", "--no-ff", "right");
    } catch {
      git(repository.merging, "checkout", "--ours", "clash.txt");
      git(repository.merging, "add", "clash.txt");
    }
  });

  after(() => rmSync(repository.scratch, { recursive: true, force: true }));

  test("is keep in every mode when named, a rebase with a clean tree and a merge with a clean index alike", () => {
    for (const folder of [repository.rebasing, repository.merging]) {
      assert.equal(git(folder, "status", "--porcelain"), "");
      const report = runScript(repository.main, "--remove-safe", `--worktree=${folder}`);
      assert.equal(report.worktrees[0].verdict, "keep");
      assert.ok(report.worktrees[0].reasons.includes(reason));
      assert.equal(existsSync(folder), true);
    }
  });
});

describe("a leftover host branch deleted with its worktree", () => {
  const makeRepository = () => {
    const repository = makeScratchRepository();
    git(repository.main, "branch", "worktree-agent-gone");
    git(repository.main, "worktree", "add", "-q", "-b", "ticket/gone", join(repository.main, ".claude", "worktrees", "agent-gone"), "worktree-agent-gone");
    return repository;
  };

  test("is neither judged nor reported again in the same run, in --json", () => {
    const repository = makeRepository();
    try {
      const report = runScript(repository.main, "--remove-safe", "--named");
      const removal = report.removals.find((entry) => entry.leftoverBranch === "worktree-agent-gone");
      assert.equal(removal.leftoverBranchDeletion.isDeleted, true);
      assert.equal(report.branches.some((entry) => entry.branch === "worktree-agent-gone"), false);
      assert.equal(report.branchRemovals.some((entry) => entry.branch === "worktree-agent-gone"), false);
    } finally {
      rmSync(repository.scratch, { recursive: true, force: true });
    }
  });

  test("prints no kept line for it in the text", () => {
    const repository = makeRepository();
    try {
      const text = execFileSync(process.execPath, [scriptPath, "--remove-safe", "--named"], { cwd: repository.main, env: gitEnvironment, encoding: "utf8" });
      assert.match(text, /deleted leftover branch worktree-agent-gone/);
      assert.doesNotMatch(text, /kept branch worktree-agent-gone/);
      assert.doesNotMatch(text, /keep worktree-agent-gone/);
    } finally {
      rmSync(repository.scratch, { recursive: true, force: true });
    }
  });
});
