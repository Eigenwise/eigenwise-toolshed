import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPlan } from "./upgrade-rules-plan.mjs";
import { runMigration } from "./upgrade-rules-convert.mjs";
import { readOptions, scan } from "./upgrade-scan.mjs";

const scratchFolders = [];

const scratchFolder = (prefix) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchFolders.push(folder);
  return folder;
};

// Thousands of these folders were found left in the temp folder: every run made some and nothing removed them.
after(() => scratchFolders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

const SCRIPT = fileURLToPath(new URL("./upgrade-rules-convert.mjs", import.meta.url));

function makeProject(rules) {
  const root = scratchFolder("older-rules-convert-");
  const rulesDirectory = path.join(root, ".claude", "live-rules", "rules");
  fs.mkdirSync(rulesDirectory, { recursive: true });
  for (const [name, content] of Object.entries(rules)) fs.writeFileSync(path.join(rulesDirectory, name), content);
  return root;
}

function planOf(root) {
  return JSON.parse(runMigration(["--project", root, "--json"], root));
}

function outputsOf(plan, name) {
  return plan.items.find((item) => item.name === name).outputs;
}

test("globs and dirs become paths, an always rule gets no frontmatter", () => {
  const root = makeProject({
    "react.md": '---\ndescription: React conventions\nglobs: ["**/*.tsx"]\ndirs: [packages/ui/]\n---\n- Use hooks.\n',
    "tone.md": "---\ndescription: House tone\n---\n- Plain words.\n",
  });
  const plan = planOf(root);
  const [react] = outputsOf(plan, "react");
  assert.equal(react.target, ".claude/rules/react.md");
  assert.equal(react.content, '---\npaths:\n  - "**/*.tsx"\n  - "packages/ui/**"\n---\n# React conventions\n\n- Use hooks.\n');
  assert.equal(outputsOf(plan, "tone")[0].content, "# House tone\n\n- Plain words.\n");
});

test("include becomes an @import relative to the new file", () => {
  const root = makeProject({ "map.md": "---\ndescription: Map\ninclude: .claude/.codebase-info/INDEX.md\n---\nRead it first.\n" });
  assert.match(outputsOf(planOf(root), "map")[0].content, /\n@\.\.\/\.codebase-info\/INDEX\.md\n$/);
});

test("a keyword-only rule becomes a skill stub whose description carries the trigger", () => {
  const root = makeProject({ "release.md": '---\ndescription: Release steps\nprompt: ["ship", "/cut (a )?release/i"]\n---\n1. Bump the version.\n' });
  const plan = planOf(root);
  const outputs = outputsOf(plan, "release");
  assert.deepEqual(outputs.map((output) => output.kind), ["skill"]);
  assert.equal(outputs[0].target, ".claude/skills/release/SKILL.md");
  assert.match(outputs[0].content, /^---\nname: release\ndescription: "Release steps\. Use when the request mentions ship\."\n---\n# Release steps/);
  assert.ok(plan.items[0].notes.some((note) => note.includes("/cut (a )?release/i")));
});

test("a rule with globs and keywords keeps its body in the rule file and the skill points at it", () => {
  const root = makeProject({ "db.md": '---\nglobs: ["*.sql"]\nprompt: [migration]\n---\nUse parameters.\n' });
  const item = planOf(root).items[0];
  assert.deepEqual(item.outputs.map((output) => output.kind), ["rule", "skill"]);
  const [rule, skill] = item.outputs;
  assert.match(rule.content, /Use parameters\./);
  assert.doesNotMatch(skill.content, /Use parameters\./);
  assert.match(skill.content, /\.claude\/rules\/db\.md/);
  assert.ok(item.notes.some((note) => note.includes("points at")));
});

test("disabled rules are skipped and reported, priority is noted", () => {
  const root = makeProject({
    "off.md": "---\nenabled: false\n---\nNope.\n",
    "loud.md": "---\npriority: 9\n---\nYes.\n",
  });
  const plan = planOf(root);
  assert.equal(plan.items.find((item) => item.name === "off").status, "skipped");
  assert.match(plan.items.find((item) => item.name === "off").reason, /disabled/);
  assert.match(plan.items.find((item) => item.name === "loud").notes[0], /priority 9/);
});

test("a rule that cannot be parsed is skipped with the reason", () => {
  const root = makeProject({ "bad.md": "---\nnot a pair\n---\nBody\n" });
  assert.match(planOf(root).items[0].reason, /cannot parse/);
});

test("an existing target is a conflict and is never overwritten", () => {
  const root = makeProject({ "style.md": "---\ndescription: Style\n---\nNew.\n" });
  const existing = path.join(root, ".claude", "rules", "style.md");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "mine");
  const plan = planOf(root);
  assert.equal(plan.items[0].status, "conflict");
  assert.deepEqual(applyPlan({ ...plan, projectRoot: root }), []);
  assert.equal(fs.readFileSync(existing, "utf8"), "mine");
});

test("default run writes nothing, --write writes and leaves the old folder", () => {
  const root = makeProject({ "a.md": "---\ndescription: A\nglobs: [src/**]\n---\nDo a.\n" });
  const dry = spawnSync(process.execPath, [SCRIPT, "--project", root], { encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Nothing written/);
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules", "a.md")), false);
  const applied = spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  assert.match(applied.stdout, /Wrote 1 files/);
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules", "a.md")), true);
  assert.equal(fs.existsSync(path.join(root, ".claude", "live-rules", "rules", "a.md")), true);
});

const OLDER_KEYS = /^(globs|dirs|prompt|include|priority|enabled):/m;

const readWritten = (root, target) => fs.readFileSync(path.join(root, target), "utf8");

test("written rules keep only native keys, so nothing in them is ignored", () => {
  const root = makeProject({
    "react.md": '---\ndescription: React\nglobs: ["**/*.tsx"]\npriority: 2\n---\n- Hooks.\n',
    "tone.md": "---\ndescription: Tone\n---\n- Plain.\n",
  });
  spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  const react = readWritten(root, ".claude/rules/react.md");
  assert.equal(react, '---\npaths:\n  - "**/*.tsx"\n---\n# React\n\n- Hooks.\n');
  assert.equal(readWritten(root, ".claude/rules/tone.md"), "# Tone\n\n- Plain.\n");
  assert.doesNotMatch(react, OLDER_KEYS);
});

test("a project with no v1 folder exits 2", () => {
  const empty = scratchFolder("older-rules-empty-");
  const result = spawnSync(process.execPath, [SCRIPT, "--project", empty], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no v1 rules/);
});

function makePage(text) {
  const root = scratchFolder("older-rules-page-");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "live-rules.md"), text);
  return root;
}

const THREE_RULE_PAGE = [
  "# Rules for the garden shed",
  "",
  "---",
  "description: Watering",
  'globs: ["beds/**"]',
  "---",
  "- Water at dawn.",
  "",
  "---",
  "description: Tool storage",
  'prompt: ["shed"]',
  "---",
  "- Hang the rakes.",
  "",
  "---",
  "description: Seed labels",
  "---",
  "- Label every packet.",
  "",
].join("\n");

test("a single-file rules page becomes three native rules and says it was read as a single file", () => {
  const root = makePage(THREE_RULE_PAGE);
  const plan = planOf(root);
  assert.equal(plan.form, "single-file");
  assert.deepEqual(plan.items.map((item) => item.name), ["watering", "tool-storage", "seed-labels"]);
  assert.deepEqual(plan.items.map((item) => item.status), ["convert", "convert", "convert"]);
  assert.equal(outputsOf(plan, "watering")[0].content, '---\npaths:\n  - "beds/**"\n---\n# Watering\n\n- Water at dawn.\n');
  assert.equal(outputsOf(plan, "tool-storage")[0].target, ".claude/skills/tool-storage/SKILL.md");
  assert.equal(outputsOf(plan, "seed-labels")[0].content, "# Seed labels\n\n- Label every packet.\n");
});

test("a single-file page with no frontmatter is one always-loaded rule", () => {
  const plan = planOf(makePage("Keep the shed door shut.\n"));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].outputs[0].content, "# rule 1\n\nKeep the shed door shut.\n");
});

test("--write on a single-file page writes the rules and leaves the page", () => {
  const root = makePage(THREE_RULE_PAGE);
  const applied = spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /Wrote 3 files/);
  assert.match(applied.stdout, /The old file is untouched/);
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules", "watering.md")), true);
  assert.equal(fs.existsSync(path.join(root, ".claude", "live-rules.md")), true);
});

test("a single-file page that cannot be parsed is reported with the reason and left in place", () => {
  const root = makePage("---\ndescription: Fine\n---\n- ok\n\n---\nnot a pair\n---\n- broken\n");
  const plan = planOf(root);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].status, "skipped");
  assert.match(plan.items[0].reason, /cannot parse: rule 2: line 7 of the file/);
  const applied = spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  assert.match(applied.stdout, /Wrote 0 files/);
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules")), false);
  assert.equal(fs.existsSync(path.join(root, ".claude", "live-rules.md")), true);
});

test("a single-file page with an unpaired --- line is reported, not cut short", () => {
  const plan = planOf(makePage("---\ndescription: A\n---\n- a\n\n---\n- b\n"));
  assert.equal(plan.items[0].status, "skipped");
  assert.match(plan.items[0].reason, /one never pairs up/);
});

test("a folder run says it read the folder form", () => {
  assert.equal(planOf(makeProject({ "a.md": "- a\n" })).form, "folder");
});

test("an include on an always-loaded rule is noted as loading every session", () => {
  const root = makeProject({
    "always.md": "---\ndescription: Always\ninclude: docs/info.md\n---\n- x\n",
    "scoped.md": '---\ndescription: Scoped\nglobs: ["src/**"]\ninclude: docs/info.md\n---\n- x\n',
  });
  const plan = planOf(root);
  assert.match(plan.items.find((item) => item.name === "always").notes.join(" "), /loads in every session/);
  assert.deepEqual(plan.items.find((item) => item.name === "scoped").notes, []);
});

test("an old rule whose glob has no slash is noted as loading at any depth, and the pattern stays as written", () => {
  const root = makeProject({
    "readme.md": '---\ndescription: Readme\nglobs: ["README.md"]\n---\n- Keep it short.\n',
    "scoped.md": '---\ndescription: Scoped\nglobs: ["docs/README.md", "**/*.tsx"]\n---\n- x\n',
  });
  const plan = planOf(root);
  const item = plan.items.find((candidate) => candidate.name === "readme");
  assert.equal(item.notes.length, 1);
  assert.match(item.notes[0], /"README\.md" has no slash/);
  assert.match(item.notes[0], /any depth/);
  assert.match(item.notes[0], /"\/name" means only the one in the root folder/);
  assert.match(item.outputs[0].content, /^---\npaths:\n  - "README\.md"\n---\n/);
  assert.deepEqual(plan.items.find((candidate) => candidate.name === "scoped").notes, []);
});

test("a v1 rule with a folded description converts", () => {
  const root = makeProject({ "long.md": "---\ndescription: >\n  Long\n  title\n---\n- x\n" });
  assert.match(outputsOf(planOf(root), "long")[0].content, /^# Long title\n/);
});

function makeGitProject(rules, { tracked }) {
  const root = makeProject(rules);
  spawnSync("git", ["init", "-q"], { cwd: root });
  if (tracked) spawnSync("git", ["add", ".claude/live-rules"], { cwd: root });
  return root;
}

function writeOutput(root) {
  return spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" }).stdout;
}

test("a folder git tracks is kept and the closing line gives no delete step", () => {
  const root = makeGitProject({ "a.md": "---\ndescription: A\n---\nDo a.\n" }, { tracked: true });
  const output = writeOutput(root);
  assert.match(output, /stays: git tracks it/);
  assert.match(output, /committed change for the repository/);
  assert.doesNotMatch(output, /delete/);
  assert.equal(planOf(root).oldRulesTracked, true);
});

test("a folder git does not track, or no repository at all, keeps the delete line", () => {
  const untracked = makeGitProject({ "a.md": "---\ndescription: A\n---\nDo a.\n" }, { tracked: false });
  const outsideRepository = makeProject({ "a.md": "---\ndescription: A\n---\nDo a.\n" });
  for (const root of [untracked, outsideRepository]) {
    assert.match(writeOutput(root), /folder is untouched: delete .*live-rules after you confirm the new rules load/);
    assert.equal(planOf(root).oldRulesTracked, false);
  }
});

test("a numeric id never becomes a skill name, the title or description names it", () => {
  const root = makeProject({ "007.md": "---\ndescription: Stock counts and reorder levels\nprompt: '\\b(stock|reorder|shelf)\\b'\n---\nThink in ranges.\n" });
  const [skill] = outputsOf(planOf(root), "007");
  assert.equal(skill.target, ".claude/skills/stock-counts-and-reorder-levels/SKILL.md");
  assert.doesNotMatch(skill.content, /name: 007/);
});

test("a numeric id with no description is named from its heading, then from its first words", () => {
  const root = makeProject({
    "015.md": "---\nprompt: [deploy]\n---\n# Deploy checklist\n- Tag first.\n",
    "017.md": "---\nprompt: [lint]\n---\nAlways run the linter before pushing code.\n",
  });
  const plan = planOf(root);
  assert.equal(outputsOf(plan, "015")[0].target, ".claude/skills/deploy-checklist/SKILL.md");
  assert.equal(outputsOf(plan, "017")[0].target, ".claude/skills/always-run-the-linter-before/SKILL.md");
});

test("a numeric id with nothing to name it from stays a rule with no skill, and the plan says so", () => {
  const root = makeProject({ "009.md": "---\nprompt: [deploy]\n---\n!!!\n" });
  const item = planOf(root).items[0];
  assert.deepEqual(item.outputs.map((output) => output.kind), ["rule"]);
  assert.ok(item.notes.some((note) => note.includes("no skill")));
});

test("a numeric id on a path-scoped rule names the rule file from its description too", () => {
  const root = makeProject({ "008.md": '---\ndescription: Table layout\nglobs: ["*.sql"]\n---\nAlign columns.\n' });
  assert.equal(outputsOf(planOf(root), "008")[0].target, ".claude/rules/table-layout.md");
});

test("a keyword trigger that is a plain list of words becomes a plain description", () => {
  const root = makeProject({
    "wordgroup.md": "---\ndescription: Stock study\nprompt: '\\b(stock|reorder|shelf)\\b'\n---\nx\n",
    "barelist.md": "---\ndescription: Test running\nprompt: [checks, unit tests]\n---\nx\n",
  });
  const plan = planOf(root);
  assert.match(outputsOf(plan, "wordgroup")[0].content, /description: "Stock study\. Use when the request mentions stock, reorder or shelf\."/);
  assert.match(outputsOf(plan, "barelist")[0].content, /description: "Test running\. Use when the request mentions checks or unit tests\."/);
  assert.deepEqual(plan.items[0].notes, []);
});

test("an expression that is not a plain list is not pasted into the description and is named in the plan", () => {
  const root = makeProject({ "fancy.md": "---\ndescription: Release steps\nprompt: '\\bcut(ting)? a? release\\b'\n---\nx\n" });
  const item = planOf(root).items[0];
  assert.equal(item.outputs[0].content.includes("cut(ting)"), false);
  assert.match(item.outputs[0].content, /description: "Release steps"/);
  assert.ok(item.notes.some((note) => note.includes("could not be turned into words") && note.includes("\\bcut(ting)? a? release\\b")));
});

test("a keyword-only rule keeps its whole body in the skill", () => {
  const root = makeProject({ "stand.md": "---\ndescription: Standup\nprompt: [standup]\n---\nKeep it short.\n" });
  assert.match(outputsOf(planOf(root), "stand")[0].content, /Keep it short\./);
});

function switchOlderRulesPluginOn(root) {
  const settingsPath = path.join(root, ".claude", "settings.local.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "live-rules@eigenwise-toolshed": true } }));
  return root;
}

function upgradeVerdictFor(root, kind, home = scratchFolder("older-rules-home-")) {
  const report = scan(readOptions(["--home", home, "--project", root], {}, root));
  return report.project.leftovers.find((leftover) => leftover.kind === kind)?.verdict;
}

function homeWithRulesPluginAt(version) {
  const home = scratchFolder("rules-home-");
  const recordPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({ version: 2, plugins: { "live-rules@eigenwise-toolshed": [{ scope: "user", installPath: "cache", version }] } }));
  return home;
}

test("after the update the rules plugin of the same name is this version's, and the old rules still convert", () => {
  const root = switchOlderRulesPluginOn(makeProject({ "react.md": '---\ndescription: React conventions\nglobs: ["**/*.tsx"]\n---\n- Use hooks.\n' }));
  assert.equal(upgradeVerdictFor(root, "rules-folder", homeWithRulesPluginAt("3.0.0")), "convert");
  assert.equal(upgradeVerdictFor(root, "older-plugin", homeWithRulesPluginAt("3.0.0")), undefined);
  assert.equal(upgradeVerdictFor(root, "older-install", homeWithRulesPluginAt("2.11.2")), "convert");
});

test("the upgrade converts an older rules folder: the scan says convert and --write gives the rule and the skill", () => {
  const root = switchOlderRulesPluginOn(makeProject({
    "react.md": '---\ndescription: React conventions\nglobs: ["**/*.tsx"]\n---\n- Use hooks.\n',
    "release.md": "---\ndescription: Release steps\nprompt: [ship, release]\n---\n1. Bump the version.\n",
  }));
  assert.equal(upgradeVerdictFor(root, "rules-folder"), "convert");
  const applied = spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /\(folder form\)/);
  assert.match(readWritten(root, ".claude/rules/react.md"), /^---\npaths:\n  - "\*\*\/\*\.tsx"\n---\n# React conventions\n/);
  assert.match(readWritten(root, ".claude/skills/release/SKILL.md"), /description: "Release steps\. Use when the request mentions ship or release\."/);
  assert.equal(upgradeVerdictFor(root, "rules-folder"), "remove");
});

test("the upgrade converts an older single rules page the same way", () => {
  const root = switchOlderRulesPluginOn(makePage(THREE_RULE_PAGE));
  assert.equal(upgradeVerdictFor(root, "rules-page"), "convert");
  const applied = spawnSync(process.execPath, [SCRIPT, "--project", root, "--write"], { encoding: "utf8" });
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /\(single-file form\)/);
  assert.match(readWritten(root, ".claude/rules/watering.md"), /^---\npaths:\n  - "beds\/\*\*"\n---\n# Watering\n/);
  assert.match(readWritten(root, ".claude/skills/tool-storage/SKILL.md"), /# Tool storage/);
  assert.equal(readWritten(root, ".claude/rules/seed-labels.md"), "# Seed labels\n\n- Label every packet.\n");
  assert.equal(upgradeVerdictFor(root, "rules-page"), "remove");
});
