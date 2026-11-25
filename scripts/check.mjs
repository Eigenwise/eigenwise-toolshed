import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderBudgetTable, measurePlugin } from "./budgets.mjs";
import {
  findClaudeBinary,
  findExecutable,
  hasHooksModule,
  hasModuleTests,
  isDirectory,
  listFilesRecursively,
  listPlugins,
  mainCheckoutRoot,
  readJson,
  repositoryRoot,
  runChild,
} from "./repository.mjs";

const PASS = "pass";
const FAIL = "FAIL";
const NOT_RUN = "not run";
const NOT_MEASURED = "not measured";
// Claude Code ships its mod types only inside its bundled plugin-authoring skill, so a fresh clone or a CI
// runner has no copy. A missing copy leaves types unmeasured; it never fails the check and never passes it.
const hostTypesFile = join(repositoryRoot, ".types", "claude-code.d.ts");
const hostTypesPath = [".types", "claude-code.d.ts"];
const SKIPPED = "-";
const failureLinesShown = 25;

// The host types are untracked, so a linked worktree starts without them: take the main checkout's copy.
function borrowHostTypesFromMainCheckout() {
  const mainCopy = join(mainCheckoutRoot() ?? repositoryRoot, ...hostTypesPath);
  if (existsSync(hostTypesFile) || !existsSync(mainCopy)) return;
  mkdirSync(dirname(hostTypesFile), { recursive: true });
  copyFileSync(mainCopy, hostTypesFile);
}

function outcomeOf(result) {
  return result.exitCode === 0 ? PASS : FAIL;
}

function findNodeTestFiles(directory) {
  return listFilesRecursively(directory).filter((path) => path.endsWith(".test.mjs"));
}

function recordFailure(failures, label, result) {
  if (result.exitCode !== 0) failures.push({ label, output: result.output });
}

function runClaudeStep(context, plugin, subcommand, failures) {
  if (!context.claudeBinary) return NOT_RUN;
  const result = runChild(context.claudeBinary, ["plugin", subcommand, plugin.directory]);
  recordFailure(failures, `${plugin.name} ${subcommand}`, result);
  return outcomeOf(result);
}

function runValidate(context, plugin, failures) {
  return runClaudeStep(context, plugin, "validate", failures);
}

function runModuleTests(context, plugin, failures) {
  if (!hasHooksModule(plugin.directory) || !hasModuleTests(plugin.directory)) return SKIPPED;
  return runClaudeStep(context, plugin, "test", failures);
}

function runTypeCheck(context, plugin, failures) {
  if (!existsSync(join(plugin.directory, "tsconfig.json"))) return SKIPPED;
  if (!context.hasHostTypes) return NOT_MEASURED;
  if (!context.typescriptCompiler) return NOT_RUN;
  const result = runChild(context.typescriptCompiler, ["-p", plugin.directory]);
  recordFailure(failures, `${plugin.name} tsc`, result);
  return outcomeOf(result);
}

function runScriptTests(plugin, failures) {
  const testFiles = findNodeTestFiles(join(plugin.directory, "scripts"));
  if (testFiles.length === 0) return SKIPPED;
  const result = runChild(process.execPath, ["--test", ...testFiles]);
  recordFailure(failures, `${plugin.name} scripts`, result);
  return outcomeOf(result);
}

function checkPlugin(context, plugin, failures) {
  if (!isDirectory(plugin.directory)) {
    failures.push({ label: `${plugin.name} folder`, output: `missing folder ${plugin.directory}` });
    return { plugin: plugin.name, validate: FAIL, test: SKIPPED, types: SKIPPED, scripts: SKIPPED };
  }
  return {
    plugin: plugin.name,
    validate: runValidate(context, plugin, failures),
    test: runModuleTests(context, plugin, failures),
    types: runTypeCheck(context, plugin, failures),
    scripts: runScriptTests(plugin, failures),
  };
}

function checkRepository(failures) {
  const repositoryTests = findNodeTestFiles(join(repositoryRoot, "tests"));
  const testsResult =
    repositoryTests.length > 0 ? runChild(process.execPath, ["--test", ...repositoryTests]) : { exitCode: 0, output: "" };
  recordFailure(failures, "repository tests", testsResult);
  const syncResult = runChild(process.execPath, [join(repositoryRoot, "scripts", "sync-shared.mjs"), "--check"]);
  recordFailure(failures, "shared files", syncResult);
  return { tests: outcomeOf(testsResult), sync: outcomeOf(syncResult) };
}

function renderSummaryTable(rows) {
  const header = ["plugin", "validate", "test", "types", "scripts"];
  const body = rows.map((row) => header.map((column) => row[column]));
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((cells) => cells[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

function isAnyCellFailing(rows) {
  return rows.some((row) => [row.validate, row.test, row.types, row.scripts].some((cell) => cell === FAIL || cell === NOT_RUN));
}

function printFailures(failures) {
  for (const failure of failures) {
    console.log(`\n--- ${failure.label} ---\n${failure.output.trim()}`);
  }
}

export function runCheck() {
  borrowHostTypesFromMainCheckout();
  const context = { claudeBinary: findClaudeBinary(), typescriptCompiler: findExecutable("tsc"), hasHostTypes: existsSync(hostTypesFile) };
  if (!context.claudeBinary) console.log("claude binary not found: validate and test cannot run, so this check fails");
  if (!context.hasHostTypes) console.log(`host types not found at ${hostTypesFile}: types are not measured. Copy types/claude-code.d.ts from Claude Code's plugin-authoring skill there to measure them.`);
  const failures = [];
  const rows = listPlugins().map((plugin) => checkPlugin(context, plugin, failures));
  const repository = checkRepository(failures);
  printFailures(failures);
  console.log(`\n${renderSummaryTable(rows)}`);
  console.log(`\nrepository tests: ${repository.tests}   shared files in sync: ${repository.sync}`);
  console.log(`\n${renderBudgetTable(listPlugins().map(measurePlugin))}`);
  const failed = isAnyCellFailing(rows) || repository.tests === FAIL || repository.sync === FAIL;
  const passedLine = context.hasHostTypes ? "check passed" : "check passed, types not measured";
  console.log(failed ? "\ncheck FAILED" : `\n${passedLine}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCheck();
}
