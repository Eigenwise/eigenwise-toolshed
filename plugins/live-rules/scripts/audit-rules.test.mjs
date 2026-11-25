import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPathIndex, effectivePatterns, patternMatchesIndex } from "./glob-match.mjs";
import { listProjectFiles } from "./project-files.mjs";
import { formatAuditTable } from "./audit-table.mjs";
import { auditRulesDirectory, isSamePath } from "./rule-audit.mjs";
import { parseFrontmatterLines, splitFrontmatter } from "./rule-files.mjs";

const scratchFolders = [];

const scratchFolder = (prefix) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchFolders.push(folder);
  return folder;
};

// Thousands of these folders were found left in the temp folder: every run made some and nothing removed them.
after(() => scratchFolders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

const SCRIPT = fileURLToPath(new URL("./audit-rules.mjs", import.meta.url));

function makeProject(files) {
  const root = scratchFolder("live-rules-audit-");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  return root;
}

function audit(root, extra = {}) {
  return auditRulesDirectory({ rulesDirectory: path.join(root, ".claude", "rules"), projectRoot: root, ...extra });
}

function findingCodes(report, file) {
  return report.rules.find((rule) => rule.file === file).findings.map((finding) => finding.code);
}

test("frontmatter reads block lists, inline lists, quoted strings and comments", () => {
  const { frontmatterLines } = splitFrontmatter('---\npaths:\n  - "src/**/*.ts"\n  - docs/**\nname: \'it\'\'s\' # why\nflags: [a, "b,c", {x,y}]\n---\nbody');
  assert.deepEqual(parseFrontmatterLines(frontmatterLines), {
    paths: ["src/**/*.ts", "docs/**"],
    name: "it's",
    flags: ["a", "b,c", "{x,y}"],
  });
});

test("frontmatter reads CRLF files and a byte order mark", () => {
  const { frontmatterLines, body } = splitFrontmatter("﻿---\r\npaths: src/**\r\n---\r\nBody\r\n");
  assert.deepEqual(parseFrontmatterLines(frontmatterLines), { paths: "src/**" });
  assert.equal(body.trim(), "Body");
});

test("effective patterns follow the engine: trailing /** dropped, bare ** means always", () => {
  assert.deepEqual(effectivePatterns(["src/**", "*.sql"]), ["src", "*.sql"]);
  assert.deepEqual(effectivePatterns("a/{b,c}/*.ts, d.md"), ["a/{b,c}/*.ts", "d.md"]);
  assert.equal(effectivePatterns(["**"]), null);
  assert.equal(effectivePatterns(undefined), null);
});

test("globs use gitignore semantics", () => {
  const index = buildPathIndex(["src/app/main.ts", "db/schema.sql", "README.md"]);
  assert.equal(patternMatchesIndex("*.sql", index), true);
  assert.equal(patternMatchesIndex("src", index), true);
  assert.equal(patternMatchesIndex("src/*.ts", index), false);
  assert.equal(patternMatchesIndex("src/**/*.ts", index), true);
  assert.equal(patternMatchesIndex("/README.md", index), true);
  assert.equal(patternMatchesIndex("app/**", index), false);
});

test("the directory walk skips node_modules and .git", () => {
  const root = makeProject({ "a/b.txt": "", "node_modules/x/y.js": "", ".git/config": "" });
  assert.deepEqual(listProjectFiles(root), ["a/b.txt"]);
});

test("git listing honours .gitignore, which the directory walk would not", () => {
  const root = makeProject({ ".gitignore": "*.log\n", "kept.txt": "", "skipped.log": "" });
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  const files = listProjectFiles(root);
  assert.ok(files.includes("kept.txt"));
  assert.ok(!files.includes("skipped.log"));
});

test("a directory that cannot be read lists as empty instead of aborting", () => {
  assert.deepEqual(listProjectFiles(path.join(os.tmpdir(), "live-rules-does-not-exist")), []);
});

test("glob matching is skipped when the project root is the home directory", () => {
  const home = makeProject({ ".claude/rules/old.md": '---\npaths: ["nothing/**"]\n---\n# Old\n' });
  const originalHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  Object.assign(process.env, { USERPROFILE: home, HOME: home });
  try {
    const report = audit(home);
    assert.equal(report.globCheck, "skipped");
    assert.equal(report.warningCount, 0);
  } finally {
    Object.assign(process.env, originalHome);
  }
});

test("on Windows the home directory matches whatever case the project root is spelled in", () => {
  const home = os.homedir();

  assert.equal(isSamePath(home.toUpperCase(), home, "win32"), true);
  assert.equal(isSamePath(`${home}${path.sep}`, home, "win32"), true);
  assert.equal(isSamePath(home.toUpperCase(), home, "linux"), home.toUpperCase() === home);
  assert.equal(isSamePath(path.join(home, "project"), home, "win32"), false);
});

test("frontmatter reads indented continuation lines and block scalars", () => {
  const { frontmatterLines } = splitFrontmatter("---\ndescription: first\n  second\nfolded: >\n  one\n  two\n\n  three\nliteral: |\n  a\n  - b\npaths:\n  - src/**\n---\nbody");
  assert.deepEqual(parseFrontmatterLines(frontmatterLines), {
    description: "first second",
    folded: "one two three",
    literal: "a\n- b",
    paths: ["src/**"],
  });
});

test("a rule with a folded description is not a parse error", () => {
  const root = makeProject({ ".claude/rules/folded.md": "---\ndescription: >\n  long text\n  more\n---\n# Folded\n" });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).errorCount, 0);
});

test("--file naming no rule under the rules directory is a usage error", () => {
  const root = makeProject({ ".claude/rules/a.md": "# A\n" });
  const result = spawnSync(process.execPath, [SCRIPT, "--file", "other.md"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no rule file matches/);
});

test("a clean project has no findings and reports always-loaded bytes", () => {
  const root = makeProject({
    "src/app.ts": "",
    ".claude/rules/style.md": "# Style\n\nUse plain words.\n",
    ".claude/rules/api.md": '---\npaths:\n  - "src/**"\n---\n# API\n\nKeep it small.\n',
  });
  const report = audit(root);
  assert.equal(report.errorCount + report.warningCount, 0);
  assert.equal(report.alwaysLoadedRuleCount, 1);
  assert.equal(report.alwaysLoadedBytes, Buffer.byteLength("# Style\n\nUse plain words."));
  assert.equal(report.rules.find((rule) => rule.file === "api.md").scope, "paths");
});

test("a glob that matches nothing is a warning naming the glob", () => {
  const root = makeProject({ "src/app.ts": "", ".claude/rules/old.md": '---\npaths: ["lib/**/*.rb"]\n---\n# Old\n' });
  const report = audit(root);
  assert.deepEqual(findingCodes(report, "old.md"), ["no-match"]);
  assert.match(report.rules[0].findings[0].message, /lib\/\*\*\/\*\.rb/);
});

test("budgets differ for always-loaded and path-scoped rules", () => {
  const big = "x".repeat(1600);
  const root = makeProject({
    "src/a.ts": "",
    ".claude/rules/always.md": `# Always\n${big}`,
    ".claude/rules/scoped.md": `---\npaths: ["src/**"]\n---\n# Scoped\n${big}`,
    ".claude/rules/scoped-big.md": `---\npaths: ["src/**"]\n---\n# Big\n${"x".repeat(2100)}`,
  });
  const report = audit(root);
  assert.deepEqual(findingCodes(report, "always.md"), ["over-budget"]);
  assert.deepEqual(findingCodes(report, "scoped.md"), []);
  assert.deepEqual(findingCodes(report, "scoped-big.md"), ["over-budget"]);
});

test("same paths with a shared heading is flagged on the later file", () => {
  const root = makeProject({
    "src/a.ts": "",
    ".claude/rules/one.md": '---\npaths: ["src/**"]\n---\n# Naming\n- a\n',
    ".claude/rules/two.md": '---\npaths: ["src/**"]\n---\n# naming\n- b\n',
    ".claude/rules/three.md": '---\npaths: ["src/**"]\n---\n# Other\n- c\n',
  });
  const report = audit(root);
  assert.deepEqual(findingCodes(report, "two.md"), ["possible-duplicate"]);
  assert.deepEqual(findingCodes(report, "one.md"), []);
  assert.deepEqual(findingCodes(report, "three.md"), []);
});

test("v1 keys are flagged with their fix", () => {
  const root = makeProject({ "a.ts": "", ".claude/rules/v1.md": '---\nglobs: ["*.ts"]\npriority: 5\n---\n# V1\n' });
  const findings = audit(root).rules[0].findings;
  assert.deepEqual(findings.map((finding) => finding.code), ["ignored-field", "ignored-field"]);
  assert.match(findings[0].fix, /paths/);
});

test("an unparseable file is reported and the exit code is 1", () => {
  const root = makeProject({ ".claude/rules/broken.md": "---\npaths: [a\nnot a pair\n---\nBody" });
  const result = spawnSync(process.execPath, [SCRIPT, "--table"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR broken\.md/);
});

test("the command prints JSON by default and exits 0 on warnings", () => {
  const root = makeProject({ ".claude/rules/old.md": '---\npaths: ["nothing/**"]\n---\n# Old\n' });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).warningCount, 1);
});

test("--file narrows the output but totals still cover every rule", () => {
  const root = makeProject({ ".claude/rules/a.md": "# A\n", ".claude/rules/b.md": "# B\n" });
  const report = audit(root, { onlyFile: path.join(root, ".claude", "rules", "b.md") });
  assert.deepEqual(report.rules.map((rule) => rule.file), ["b.md"]);
  assert.equal(report.alwaysLoadedRuleCount, 2);
});

test("an unknown flag exits 2 with usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

test("the codebase map's own files are skipped, and the table says so", () => {
  const project = makeProject({
    "src/a.ts": "x",
    ".claude/rules/codebase-map.md": `# Map\n${"line about an area\n".repeat(80)}`,
    ".claude/rules/map/area.md": `---\npaths:\n  - src/**\n---\n# Area\n${"x".repeat(2400)}`,
  });
  const report = audit(project);
  assert.deepEqual(report.rules, []);
  assert.equal(report.skippedCodebaseMapFiles, 2);
  assert.equal(report.warningCount, 0);
  assert.match(formatAuditTable(report), /Skipped 2 codebase map files/);
});

test("the codebase map index still counts in the always-loaded total", () => {
  const indexBody = "line about an area\n".repeat(80);
  const project = makeProject({
    ".claude/rules/codebase-map.md": `# Map\n${indexBody}`,
    ".claude/rules/other.md": "# Other\nBe kind.\n",
  });
  const report = audit(project);
  const indexBytes = report.codebaseMapIndexBytes;
  assert.ok(indexBytes > 1500);
  assert.equal(report.alwaysLoadedRuleCount, 2);
  assert.ok(report.alwaysLoadedBytes > indexBytes);
  assert.match(formatAuditTable(report), new RegExp(`the index's ${indexBytes} bytes are in the always-loaded total`));
});

test("an ordinary rule over the limit still warns, even beside the codebase map", () => {
  const project = makeProject({
    "src/a.ts": "x",
    ".claude/rules/map/area.md": `---\npaths:\n  - src/**\n---\n# Area\n${"x".repeat(2400)}`,
    ".claude/rules/guides/long.md": `---\npaths:\n  - src/**\n---\n# Guide\n${"z".repeat(3000)}`,
  });
  const report = audit(project);
  assert.deepEqual(findingCodes(report, "guides/long.md"), ["over-budget"]);
  assert.equal(report.skippedCodebaseMapFiles, 1);
});
