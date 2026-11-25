import os from "node:os";
import path from "node:path";
import { UsageError } from "./command-line.mjs";
import { buildPathIndex, effectivePatterns, patternMatchesIndex } from "./glob-match.mjs";
import { listProjectFiles } from "./project-files.mjs";
import { listMarkdownFiles, readRuleFile } from "./rule-files.mjs";

export const ALWAYS_LOADED_BUDGET_BYTES = 1500;
export const SCOPED_BUDGET_BYTES = 2048;

// Another plugin owns these files and checks them against its own limits, which differ from the ones for rules.
export const CODEBASE_MAP_INDEX_FILE = "codebase-map.md";
export const CODEBASE_MAP_CARDS_FOLDER = "map/";

const FIELDS_CLAUDE_CODE_IGNORES = {
  globs: 'Rename the key to "paths".',
  glob: 'Rename the key to "paths".',
  dirs: 'Move each directory into "paths" as "<dir>/**".',
  dir: 'Move the directory into "paths" as "<dir>/**".',
  prompt: "Rules cannot match prompt words. Turn this into a skill whose description names the trigger.",
  prompts: "Rules cannot match prompt words. Turn this into a skill whose description names the trigger.",
  keywords: "Rules cannot match prompt words. Turn this into a skill whose description names the trigger.",
  include: 'Replace the key with an "@path" line in the body.',
  includes: 'Replace the key with an "@path" line in the body.',
  priority: "Rules have no priority. Delete the key.",
  enabled: "Rules have no on/off key. Move the file out of .claude/rules/ to switch it off.",
};

export function auditRulesDirectory({ rulesDirectory, projectRoot, onlyFile }) {
  const everyRule = listMarkdownFiles(rulesDirectory).map((filePath) => loadRule(rulesDirectory, filePath));
  const loaded = everyRule.filter((rule) => !isCodebaseMapFile(rule.file));
  const skippedCodebaseMapFiles = everyRule.length - loaded.length;
  const codebaseMapIndexBytes = everyRule.find((rule) => rule.file === CODEBASE_MAP_INDEX_FILE && rule.patterns === null)?.bodyBytes ?? 0;
  const pathIndex = buildIndexWhenNeeded(loaded, projectRoot);
  const duplicateFindings = findDuplicateFindings(loaded);
  const rules = loaded.map((rule) => auditRule(rule, pathIndex, duplicateFindings.get(rule.file) ?? []));
  return buildReport({ rulesDirectory, projectRoot, onlyFile, rules, globCheckRan: pathIndex !== null, skippedCodebaseMapFiles, codebaseMapIndexBytes });
}

function isCodebaseMapFile(file) {
  return file === CODEBASE_MAP_INDEX_FILE || file.startsWith(CODEBASE_MAP_CARDS_FOLDER);
}

function loadRule(rulesDirectory, filePath) {
  const file = path.relative(rulesDirectory, filePath).split(path.sep).join("/");
  try {
    const { data, body } = readRuleFile(filePath);
    return { file, data, body, patterns: effectivePatterns(data.paths), bodyBytes: Buffer.byteLength(body) };
  } catch (error) {
    return { file, parseError: error.message };
  }
}

// A Windows drive and folder names ignore case, so C:\Users\Me and c:\users\me are one folder.
export function isSamePath(left, right, platform = process.platform) {
  const normalized = [left, right].map((folder) => path.resolve(folder));
  const [leftFolder, rightFolder] = platform === "win32" ? normalized.map((folder) => folder.toLowerCase()) : normalized;
  return leftFolder === rightFolder;
}

function buildIndexWhenNeeded(loaded, projectRoot) {
  const hasScopedRule = loaded.some((rule) => Array.isArray(rule.patterns));
  const isUserScope = isSamePath(projectRoot, os.homedir());
  if (!hasScopedRule || isUserScope) return null;
  return buildPathIndex(listProjectFiles(projectRoot));
}

function auditRule(rule, pathIndex, duplicateFindings) {
  if (rule.parseError !== undefined) {
    const finding = makeFinding("parse-error", "error", rule.parseError, "Fix the frontmatter so each line is key: value or a - item.");
    return { file: rule.file, scope: "unreadable", paths: [], bodyBytes: 0, findings: [finding] };
  }
  const findings = [
    ...ignoredFieldFindings(rule.data),
    ...unmatchedPatternFindings(rule.patterns, pathIndex),
    ...budgetFindings(rule),
    ...duplicateFindings,
  ];
  const scope = rule.patterns === null ? "always" : "paths";
  return { file: rule.file, scope, paths: rule.patterns ?? [], bodyBytes: rule.bodyBytes, findings };
}

function makeFinding(code, severity, message, fix) {
  return { code, severity, message, fix };
}

function ignoredFieldFindings(data) {
  return Object.keys(data)
    .filter((key) => key in FIELDS_CLAUDE_CODE_IGNORES)
    .map((key) => makeFinding("ignored-field", "warning", `"${key}" is a live-rules v1 key and Claude Code ignores it`, FIELDS_CLAUDE_CODE_IGNORES[key]));
}

function unmatchedPatternFindings(patterns, pathIndex) {
  if (patterns === null || pathIndex === null) return [];
  return patterns
    .filter((pattern) => !patternMatchesIndex(pattern, pathIndex))
    .map((pattern) => makeFinding("no-match", "warning", `paths glob "${pattern}" matches no file in the project`, "Fix the glob, or delete the rule if that code is gone."));
}

function budgetFindings(rule) {
  const isAlwaysLoaded = rule.patterns === null;
  const budget = isAlwaysLoaded ? ALWAYS_LOADED_BUDGET_BYTES : SCOPED_BUDGET_BYTES;
  if (rule.bodyBytes <= budget) return [];
  const fix = isAlwaysLoaded
    ? "Trim it, or add a paths glob so it loads only where it applies."
    : "Trim it, or split it by concern into separate files.";
  return [makeFinding("over-budget", "warning", `body is ${rule.bodyBytes} bytes, the budget here is ${budget}`, fix)];
}

function findDuplicateFindings(loaded) {
  const readable = loaded.filter((rule) => rule.parseError === undefined);
  const findingsByFile = new Map();
  readable.forEach((later, index) => {
    for (const earlier of readable.slice(0, index).filter((candidate) => isPossibleDuplicate(candidate, later))) {
      const finding = makeFinding("possible-duplicate", "warning", `same paths and a shared heading as ${earlier.file}`, `Merge it into ${earlier.file} or delete one of the two.`);
      findingsByFile.set(later.file, [...(findingsByFile.get(later.file) ?? []), finding]);
    }
  });
  return findingsByFile;
}

function isPossibleDuplicate(first, second) {
  if (scopeKey(first) !== scopeKey(second)) return false;
  const secondHeadings = extractHeadings(second.body);
  return extractHeadings(first.body).some((heading) => secondHeadings.includes(heading));
}

function scopeKey(rule) {
  return rule.patterns === null ? "(always)" : [...rule.patterns].sort().join("\n");
}

function extractHeadings(body) {
  return body
    .split("\n")
    .map((line) => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1].toLowerCase())
    .filter((heading) => heading !== undefined);
}

function buildReport({ rulesDirectory, projectRoot, onlyFile, rules, globCheckRan, skippedCodebaseMapFiles, codebaseMapIndexBytes }) {
  const alwaysLoaded = rules.filter((rule) => rule.scope === "always");
  const shown = selectRules(rules, rulesDirectory, onlyFile);
  return {
    rulesDirectory,
    projectRoot,
    globCheck: globCheckRan ? "ran" : "skipped",
    rules: shown,
    skippedCodebaseMapFiles,
    codebaseMapIndexBytes,
    alwaysLoadedRuleCount: alwaysLoaded.length + (codebaseMapIndexBytes > 0 ? 1 : 0),
    alwaysLoadedBytes: alwaysLoaded.reduce((total, rule) => total + rule.bodyBytes, codebaseMapIndexBytes),
    errorCount: countFindings(shown, "error"),
    warningCount: countFindings(shown, "warning"),
  };
}

function selectRules(rules, rulesDirectory, onlyFile) {
  if (onlyFile === undefined) return rules;
  const wanted = path.relative(rulesDirectory, path.resolve(onlyFile)).split(path.sep).join("/");
  const selected = rules.filter((rule) => rule.file === wanted);
  if (selected.length === 0) throw new UsageError(`no rule file matches ${onlyFile} under ${rulesDirectory}`);
  return selected;
}

function countFindings(rules, severity) {
  return rules.flatMap((rule) => rule.findings).filter((finding) => finding.severity === severity).length;
}
