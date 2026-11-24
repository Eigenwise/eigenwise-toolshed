import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findClaudeBinary, hasHooksModule, hasModuleTests, readMarketplace, repositoryRoot, runChild } from "./repository.mjs";

// Installs every plugin from a marketplace source into an empty Claude config, then validates and tests
// the installed copy. It catches what a checkout cannot: files that exist in the repo but never ship.
function run(claudeBinary, args, environment) {
  return runChild(claudeBinary, args, { env: environment });
}

function installAll(claudeBinary, marketplaceSource, environment, failures) {
  const added = run(claudeBinary, ["plugin", "marketplace", "add", marketplaceSource], environment);
  if (added.exitCode !== 0) {
    failures.push({ label: `marketplace add ${marketplaceSource}`, output: added.output });
    return undefined;
  }
  const marketplace = readMarketplace();
  for (const plugin of marketplace.plugins) {
    const installed = run(claudeBinary, ["plugin", "install", `${plugin.name}@${marketplace.name}`], environment);
    if (installed.exitCode !== 0) failures.push({ label: `install ${plugin.name}`, output: installed.output });
  }
  const listed = run(claudeBinary, ["plugin", "list", "--json"], environment);
  if (listed.exitCode !== 0) {
    failures.push({ label: "plugin list", output: listed.output });
    return undefined;
  }
  const installPaths = new Map(JSON.parse(listed.output).map((entry) => [entry.id, entry.installPath]));
  return { marketplace, installPaths };
}

function subcommandsFor(installPath) {
  return hasHooksModule(installPath) && hasModuleTests(installPath) ? ["validate", "test"] : ["validate"];
}

function checkInstalledCopy(claudeBinary, name, installPath, environment, failures) {
  if (!installPath || !existsSync(installPath)) {
    failures.push({ label: `${name} installed copy`, output: "plugin is not installed" });
    return;
  }
  for (const subcommand of subcommandsFor(installPath)) {
    const result = run(claudeBinary, ["plugin", subcommand, installPath], environment);
    if (result.exitCode !== 0) failures.push({ label: `${name} installed ${subcommand}`, output: result.output });
  }
}

function checkEveryInstalledCopy(claudeBinary, installation, environment, failures) {
  if (!installation) return;
  for (const plugin of installation.marketplace.plugins) {
    const installPath = installation.installPaths.get(`${plugin.name}@${installation.marketplace.name}`);
    checkInstalledCopy(claudeBinary, plugin.name, installPath, environment, failures);
  }
}

function installAndCheck(claudeBinary, marketplaceSource) {
  const configDirectory = mkdtempSync(join(tmpdir(), "toolshed-clean-room-"));
  const environment = { ...process.env, CLAUDE_CONFIG_DIR: configDirectory };
  const failures = [];
  try {
    const installation = installAll(claudeBinary, marketplaceSource, environment, failures);
    checkEveryInstalledCopy(claudeBinary, installation, environment, failures);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
  return failures;
}

function reportFailures(failures) {
  for (const failure of failures) console.log(`\n--- ${failure.label} ---\n${failure.output.trim()}`);
  console.log(failures.length === 0 ? "\nclean room passed" : "\nclean room FAILED");
  return failures.length === 0 ? 0 : 1;
}

export function runCleanRoom(marketplaceSource) {
  const claudeBinary = findClaudeBinary();
  if (!claudeBinary) {
    console.log("claude binary not found: the clean-room check cannot run");
    return 1;
  }
  return reportFailures(installAndCheck(claudeBinary, marketplaceSource));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCleanRoom(process.argv[2] ?? repositoryRoot);
}
