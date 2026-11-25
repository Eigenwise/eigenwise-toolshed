import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { cardPathspec, formatLine, mapRoot, mapStatus, parseCard, repositoryRoot } from "./map-status.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "map-status.mjs");
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

describe("parseCard", () => {
  test("reads a block list of paths and the verified commit", () => {
    const card = parseCard('---\npaths:\n  - "src/api/**"\n  - lib/**\nverified-at: abc123\n---\nBody\n');
    assert.deepEqual(card, { paths: ["src/api/**", "lib/**"], verifiedAt: "abc123" });
  });

  test("reads an inline list and a single quoted path", () => {
    assert.deepEqual(parseCard("---\npaths: [\"a/**\", 'b/**']\n---\n").paths, ["a/**", "b/**"]);
    assert.deepEqual(parseCard('---\npaths: "a/**/*.ts"\n---\n').paths, ["a/**/*.ts"]);
  });

  test("reads Windows line endings and a card with no frontmatter", () => {
    assert.deepEqual(parseCard("---\r\npaths:\r\n  - a/**\r\nverified-at: f00\r\n---\r\n").paths, ["a/**"]);
    assert.deepEqual(parseCard("no frontmatter"), { paths: [], verifiedAt: null });
  });
});

describe("formatLine", () => {
  test("says how many cards are stale", () => {
    assert.equal(formatLine({ total: 7, stale: 2, withEmptyGlobs: 0 }), "Codebase map: 2 of 7 areas out of date. /codebase-mapper:refresh updates them.");
  });

  test("mentions globs that match no file", () => {
    assert.equal(
      formatLine({ total: 3, stale: 0, withEmptyGlobs: 1 }),
      "Codebase map: 0 of 3 areas out of date, 1 point at files that are gone. /codebase-mapper:refresh updates them.",
    );
  });

  test("handles a fresh map and no map", () => {
    assert.equal(formatLine({ total: 3, stale: 0, withEmptyGlobs: 0 }), "Codebase map: all 3 areas up to date.");
    assert.equal(formatLine({ total: 0, stale: 0, withEmptyGlobs: 0 }), "Codebase map: no areas yet.");
  });
});

describe("mapStatus in a git repository", () => {
  let root;

  function git(...args) {
    return execFileSync("git", args, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
  }

  function writeIn(relativePath, text) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  }

  function commitFile(relativePath, text) {
    writeIn(relativePath, text);
    git("add", "-A");
    git("commit", "-m", `change ${relativePath}`);
    return git("rev-parse", "HEAD");
  }

  function writeCard(name, frontmatter) {
    writeIn(`.claude/rules/map/${name}.md`, `---\n${frontmatter}\n---\nCard body.\n`);
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "map-status-"));
    git("init", "-q");
    commitFile("src/api/routes.ts", "one");
    commitFile("lib/store.ts", "one");
    const verified = git("rev-parse", "HEAD");
    writeCard("api", `paths:\n  - "src/api/**"\nverified-at: ${verified}`);
    writeCard("store", `paths:\n  - lib/**\nverified-at: ${verified}`);
    writeCard("ghost", `paths:\n  - nowhere/**\nverified-at: ${verified}`);
    git("add", "-A");
    git("commit", "-m", "add cards");
    commitFile("src/api/routes.ts", "two");
    commitFile("src/api/more.ts", "three");
    commitFile("docs/readme.md", "unrelated");
    writeCard("unstamped", "paths:\n  - lib/**");
    writeCard("rewound", "paths:\n  - lib/**\nverified-at: 0000000000000000000000000000000000000000");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  function cardNamed(name) {
    return mapStatus(root).cards.find((card) => card.card === `${name}.md`);
  }

  test("counts only the commits under the card's own globs", () => {
    assert.equal(cardNamed("api").status, "stale");
    assert.equal(cardNamed("api").commits, 2);
  });

  test("a card whose area did not change is fresh", () => {
    assert.equal(cardNamed("store").status, "fresh");
    assert.equal(cardNamed("store").commits, 0);
  });

  test("reports globs that match no file", () => {
    assert.deepEqual(cardNamed("ghost").emptyGlobs, ["nowhere/**"]);
    assert.deepEqual(cardNamed("store").emptyGlobs, []);
  });

  test("a card without verified-at, or with an unknown commit, is stale with a reason", () => {
    assert.equal(cardNamed("unstamped").reason, "no verified-at");
    assert.equal(cardNamed("rewound").status, "stale");
    assert.match(cardNamed("rewound").reason, /not a commit/);
  });

  test("a card that git cannot count is not blamed on verified-at", () => {
    writeCard("badglob", `paths:
  - "../outside/**"
verified-at: ${git("rev-parse", "HEAD")}`);
    const reason = cardNamed("badglob").reason;
    rmSync(join(root, ".claude/rules/map/badglob.md"));
    assert.equal(reason, "git could not count the commits");
  });

  test("run from a subfolder, the command still finds the cards at the repository top", () => {
    const subfolder = join(root, "src/api");
    const json = JSON.parse(execFileSync("node", [scriptPath, "--root", subfolder], { encoding: "utf8" }));
    assert.equal(json.total, 5);
    const slashed = (path) => path.replaceAll("\\", "/");
    // git answers with the long path; a CI runner hands out an 8.3 short TEMP path.
    assert.equal(slashed(repositoryRoot(subfolder)), slashed(realpathSync.native(root)));
  });

  test("totals and the one-line summary agree", () => {
    const status = mapStatus(root);
    assert.equal(status.total, 5);
    assert.equal(status.stale, 3);
    assert.equal(status.line, "Codebase map: 3 of 5 areas out of date, 1 point at files that are gone. /codebase-mapper:refresh updates them.");
  });

  test("the command prints JSON, or one line with --line", () => {
    const json = JSON.parse(execFileSync("node", [scriptPath, "--root", root], { encoding: "utf8" }));
    assert.equal(json.stale, 3);
    const line = execFileSync("node", [scriptPath, "--root", root, "--line"], { encoding: "utf8" });
    assert.equal(line, "Codebase map: 3 of 5 areas out of date, 1 point at files that are gone. /codebase-mapper:refresh updates them.\n");
  });
});

describe("cardPathspec", () => {
  test("a pattern with no slash matches at any depth", () => {
    assert.equal(cardPathspec("README.md"), ":(glob)**/README.md");
    assert.equal(cardPathspec("*.md"), ":(glob)**/*.md");
  });

  test("a leading slash means the top folder only", () => {
    assert.equal(cardPathspec("/README.md"), ":(glob)README.md");
  });

  test("a pattern with a slash inside stays as written", () => {
    assert.equal(cardPathspec("src/api/**"), ":(glob)src/api/**");
  });

  test("a ./ pattern has no pathspec because the host never loads it", () => {
    assert.equal(cardPathspec("./README.md"), null);
  });
});

describe("formatLine with patterns the host never loads", () => {
  test("says how many cards carry one", () => {
    assert.equal(
      formatLine({ total: 3, stale: 1, withEmptyGlobs: 0, withNeverLoaded: 2 }),
      "Codebase map: 1 of 3 areas out of date, 2 use a path pattern Claude Code never loads. /codebase-mapper:refresh updates them.",
    );
  });

  test("a map with only such cards is not reported fresh", () => {
    assert.equal(
      formatLine({ total: 1, stale: 0, withEmptyGlobs: 0, withNeverLoaded: 1 }),
      "Codebase map: 0 of 1 areas out of date, 1 use a path pattern Claude Code never loads. /codebase-mapper:refresh updates them.",
    );
  });
});

describe("a card scoped to a file name", () => {
  let root;

  function git(...args) {
    return execFileSync("git", args, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
  }

  function commitFile(relativePath, text) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
    git("add", "-A");
    git("commit", "-m", `change ${relativePath}`);
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "map-status-names-"));
    git("init", "-q");
    commitFile("README.md", "root");
    commitFile("docs/README.md", "nested");
    const verified = git("rev-parse", "HEAD");
    for (const [name, pattern] of [["bare", "README.md"], ["rooted", "/README.md"], ["dotted", "./README.md"]]) {
      mkdirSync(join(root, ".claude/rules/map"), { recursive: true });
      writeFileSync(join(root, `.claude/rules/map/${name}.md`), `---\npaths:\n  - "${pattern}"\nverified-at: ${verified}\n---\nBody.\n`);
    }
    git("add", "-A");
    git("commit", "-m", "add cards");
    commitFile("docs/README.md", "nested again");
    commitFile("README.md", "root again");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  function cardNamed(name) {
    return mapStatus(root).cards.find((card) => card.card === `${name}.md`);
  }

  test("a bare name counts the file at any depth", () => {
    assert.equal(cardNamed("bare").commits, 2);
    assert.deepEqual(cardNamed("bare").emptyGlobs, []);
  });

  test("a leading slash counts the top folder's file only and is not reported as matching nothing", () => {
    assert.equal(cardNamed("rooted").commits, 1);
    assert.deepEqual(cardNamed("rooted").emptyGlobs, []);
  });

  test("a ./ pattern is reported as never loaded, with no invented match", () => {
    const dotted = cardNamed("dotted");
    assert.deepEqual(dotted.neverLoaded, ["./README.md"]);
    assert.deepEqual(dotted.emptyGlobs, []);
    assert.equal(dotted.status, "stale");
    assert.match(dotted.reason, /the host never loads/);
    assert.match(mapStatus(root).line, /1 use a path pattern Claude Code never loads/);
  });
});

describe("a card counted from its own last commit", () => {
  const roots = [];
  const cardPath = ".claude/rules/map/area.md";

  function openRepository() {
    const root = mkdtempSync(join(tmpdir(), "map-status-card-commit-"));
    roots.push(root);
    const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
    const writeIn = (relativePath, text) => {
      mkdirSync(dirname(join(root, relativePath)), { recursive: true });
      writeFileSync(join(root, relativePath), text);
    };
    const writeCard = (verifiedAt) =>
      writeIn(cardPath, `---\npaths:\n  - "src/area/**"\nverified-at: ${verifiedAt}\n---\nCard body.\n`);
    const commitAll = (message) => {
      git("add", "-A");
      git("commit", "-m", message);
    };
    git("init", "-q");
    writeIn("src/area/file.ts", "one");
    commitAll("base");
    return { root, git, writeIn, writeCard, commitAll, mainBranch: git("branch", "--show-current") };
  }

  function areaCard(root) {
    return mapStatus(root).cards.find((card) => card.card === "area.md");
  }

  function changeAreaAndCardTogether(repository) {
    const { git, writeIn, writeCard, commitAll } = repository;
    git("checkout", "-q", "-b", "feature");
    const commitBeforeChange = git("rev-parse", "HEAD");
    writeIn("src/area/file.ts", "two");
    writeCard(commitBeforeChange);
    commitAll("change the area and its card");
  }

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("is fresh on the branch that carries the card and the change together", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    assert.equal(areaCard(repository.root).status, "fresh");
    assert.equal(areaCard(repository.root).countedFrom, "verified-at");
  });

  test("is fresh on main after a plain merge", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--no-ff", "-m", "merge feature", "feature");
    assert.equal(areaCard(repository.root).status, "fresh");
  });

  test("is fresh on main after a squash merge with the branch deleted", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--squash", "feature");
    repository.commitAll("squashed feature");
    repository.git("branch", "-D", "feature");
    assert.equal(areaCard(repository.root).status, "fresh");
  });

  test("is fresh on main after a rebase", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.writeIn("docs/readme.md", "elsewhere");
    repository.commitAll("unrelated change on main");
    repository.git("checkout", "-q", "feature");
    repository.git("rebase", repository.mainBranch);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--ff-only", "feature");
    assert.equal(areaCard(repository.root).status, "fresh");
  });

  test("is stale by one after a later commit under its globs that leaves the card alone", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    repository.writeIn("src/area/more.ts", "later");
    repository.commitAll("change the area again");
    assert.equal(areaCard(repository.root).status, "stale");
    assert.equal(areaCard(repository.root).commits, 1);
  });

  function stampOnBranchCommit(repository) {
    const { git, writeIn, writeCard, commitAll } = repository;
    git("checkout", "-q", "-b", "feature");
    writeIn("src/area/file.ts", "two");
    commitAll("change the area");
    writeCard(git("rev-parse", "HEAD"));
    commitAll("add the card stamped with the branch commit");
  }

  test("is fresh after a squash merge when the stamp is a commit of the branch that still exists", () => {
    const repository = openRepository();
    stampOnBranchCommit(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--squash", "feature");
    repository.commitAll("squashed feature");
    const card = areaCard(repository.root);
    assert.equal(card.status, "fresh");
    assert.equal(card.countedFrom, "card-commit");
  });

  test("is fresh after a rebase when the stamp is a commit from before the rebase", () => {
    const repository = openRepository();
    stampOnBranchCommit(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.writeIn("docs/readme.md", "elsewhere");
    repository.commitAll("unrelated change on main");
    repository.git("checkout", "-q", "feature");
    repository.git("rebase", repository.mainBranch);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--ff-only", "feature");
    assert.equal(areaCard(repository.root).status, "fresh");
  });

  function addCardThenChangeAreaWithoutCard(repository) {
    const { git, writeIn, writeCard, commitAll } = repository;
    writeCard(git("rev-parse", "HEAD"));
    commitAll("add the card");
    writeIn("src/area/file.ts", "two");
    commitAll("change the area");
  }

  test("stays stale by one when only the card's words are fixed after the area changed", () => {
    const repository = openRepository();
    addCardThenChangeAreaWithoutCard(repository);
    const stamp = repository.git("rev-parse", "HEAD~2");
    repository.writeIn(cardPath, `---\npaths:\n  - "src/area/**"\nverified-at: ${stamp}\n---\nA typo fixed.\n`);
    repository.commitAll("fix a typo in the card");
    const card = areaCard(repository.root);
    assert.equal(card.status, "stale");
    assert.equal(card.commits, 1);
  });

  test("stays stale by one when the card is only renamed after the area changed", () => {
    const repository = openRepository();
    addCardThenChangeAreaWithoutCard(repository);
    repository.git("mv", cardPath, ".claude/rules/map/renamed.md");
    repository.commitAll("rename the card");
    const card = mapStatus(repository.root).cards.find((entry) => entry.card === "renamed.md");
    assert.equal(card.status, "stale");
    assert.equal(card.commits, 1);
  });

  test("is fresh after a commit that only moved the stamp", () => {
    const repository = openRepository();
    addCardThenChangeAreaWithoutCard(repository);
    repository.writeCard(repository.git("rev-parse", "HEAD"));
    repository.commitAll("re-read the card");
    const card = areaCard(repository.root);
    assert.equal(card.status, "fresh");
    assert.equal(card.countedFrom, "verified-at");
  });

  test("counts from a stamp that is newer than the card's last commit", () => {
    const repository = openRepository();
    changeAreaAndCardTogether(repository);
    repository.writeIn("src/area/more.ts", "later");
    repository.commitAll("change the area again");
    repository.writeCard(repository.git("rev-parse", "HEAD"));
    const card = areaCard(repository.root);
    assert.equal(card.status, "fresh");
    assert.equal(card.countedFrom, "verified-at");
  });

  function landTeammateChangeThenBranchWithStampAtItsBase(repository) {
    const { git, writeIn, writeCard, commitAll, mainBranch } = repository;
    git("checkout", "-q", "-b", "feature");
    const branchBase = git("rev-parse", "HEAD");
    writeIn("src/area/file.ts", "two");
    writeCard(branchBase);
    commitAll("change the area and its card on the branch");
    git("checkout", "-q", mainBranch);
    writeIn("src/area/teammate.ts", "teammate");
    commitAll("a teammate changes the area, the card is untouched");
  }

  test("is stale by one after a squash when a teammate changed the area while the branch was open", () => {
    const repository = openRepository();
    landTeammateChangeThenBranchWithStampAtItsBase(repository);
    repository.git("merge", "--squash", "feature");
    repository.commitAll("squashed feature");
    repository.git("branch", "-D", "feature");
    const card = areaCard(repository.root);
    assert.equal(card.status, "stale");
    assert.equal(card.commits, 1);
  });

  test("is stale by one after a plain merge when a teammate changed the area while the branch was open", () => {
    const repository = openRepository();
    landTeammateChangeThenBranchWithStampAtItsBase(repository);
    repository.git("merge", "--no-ff", "-m", "merge feature", "feature");
    const card = areaCard(repository.root);
    assert.equal(card.status, "stale");
    assert.equal(card.commits, 1);
  });

  test("is fresh after a squash of a stamp from a branch commit, and a fresh clone agrees", () => {
    const repository = openRepository();
    stampOnBranchCommit(repository);
    repository.git("checkout", "-q", repository.mainBranch);
    repository.git("merge", "--squash", "feature");
    repository.commitAll("squashed feature");
    repository.git("branch", "-D", "feature");
    const clonedFolder = mkdtempSync(join(tmpdir(), "map-status-clone-"));
    roots.push(clonedFolder);
    execFileSync("git", ["clone", "-q", repository.root, clonedFolder], { env: gitEnvironment });
    for (const folder of [repository.root, clonedFolder]) {
      const card = areaCard(folder);
      assert.equal(card.status, "fresh");
      assert.equal(card.countedFrom, "card-commit");
    }
  });

  test("an edit to the card in a commit that changes the area does not vouch for the earlier misses", () => {
    const repository = openRepository();
    addCardThenChangeAreaWithoutCard(repository);
    repository.writeIn("src/area/second.ts", "again");
    repository.commitAll("change the area again");
    repository.writeIn("src/area/file.ts", "three");
    repository.writeIn(cardPath, repository.git("show", `HEAD:${cardPath}`).concat("A new line.\n"));
    repository.commitAll("change the area and add a line to the card");
    const card = areaCard(repository.root);
    assert.equal(card.status, "stale");
    assert.equal(card.commits, 2);
  });

  test("counts an untracked card from its stamp", () => {
    const repository = openRepository();
    repository.writeCard(repository.git("rev-parse", "HEAD"));
    repository.writeIn("src/area/file.ts", "two");
    repository.git("commit", "-q", "-am", "change the area");
    const card = areaCard(repository.root);
    assert.equal(card.commits, 1);
    assert.equal(card.countedFrom, "verified-at");
  });

  test("counts from the card's commit when the stamp is not a commit", () => {
    const repository = openRepository();
    repository.writeCard("0000000000000000000000000000000000000000");
    repository.commitAll("add the card");
    assert.equal(areaCard(repository.root).status, "fresh");
    repository.writeIn("src/area/file.ts", "two");
    repository.commitAll("change the area");
    const card = areaCard(repository.root);
    assert.equal(card.commits, 1);
    assert.equal(card.countedFrom, "card-commit");
  });

  test("reports nothing counted for a stamp that is not a commit on a card no commit holds", () => {
    const repository = openRepository();
    repository.writeCard("0000000000000000000000000000000000000000");
    const card = areaCard(repository.root);
    assert.equal(card.countedFrom, null);
    assert.match(card.reason, /not a commit/);
  });
});

describe("a project whose .claude folder sits below the repository top", () => {
  let root;
  let projectFolder;

  function git(...args) {
    return execFileSync("git", args, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
  }

  function commitFile(relativePath, text) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
    git("add", "-A");
    git("commit", "-m", `change ${relativePath}`);
  }

  function statusLine(folder) {
    return execFileSync("node", [scriptPath, "--root", folder, "--line"], { encoding: "utf8" }).trim();
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "map-status-nested-"));
    projectFolder = join(root, "project");
    git("init", "-q");
    commitFile("project/src/area/file.ts", "one");
    commitFile("other/src/area/file.ts", "one");
    const verified = git("rev-parse", "HEAD");
    commitFile(
      "project/.claude/rules/map/area.md",
      `---\npaths:\n  - "src/area/**"\nverified-at: ${verified}\n---\nCard body.\n`,
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test("finds the card and judges it fresh", () => {
    assert.equal(statusLine(projectFolder), "Codebase map: all 1 areas up to date.");
  });

  test("a commit under the card's globs inside the project makes it stale", () => {
    commitFile("project/src/area/more.ts", "two");
    assert.equal(statusLine(projectFolder), "Codebase map: 1 of 1 areas out of date. /codebase-mapper:refresh updates them.");
    assert.equal(mapRoot(join(projectFolder, "src/area")), projectFolder);
  });

  test("a commit under the same glob outside the project is not counted", () => {
    commitFile("other/src/area/more.ts", "two");
    assert.equal(mapStatus(projectFolder).cards[0].commits, 1);
  });

  test("with no cards folder anywhere the repository top is the root", () => {
    const empty = mkdtempSync(join(tmpdir(), "map-status-bare-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: empty });
      assert.equal(mapRoot(empty), repositoryRoot(empty));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

test("a repository with no cards reports no map", () => {
  const empty = mkdtempSync(join(tmpdir(), "map-status-empty-"));
  try {
    assert.equal(mapStatus(empty).line, "Codebase map: no areas yet.");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
