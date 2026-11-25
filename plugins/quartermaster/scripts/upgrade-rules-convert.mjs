#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags, UsageError } from "./command-line.mjs";
import { applyPlan, formatPlan, planMigration } from "./upgrade-rules-plan.mjs";

const USAGE = "usage: upgrade-rules-convert.mjs [--project <dir>] [--write] [--json]";

export function runMigration(argv, workingDirectory) {
  const flags = parseFlags(argv, { valueFlags: ["--project"], booleanFlags: ["--write", "--json"] });
  const plan = planMigration(path.resolve(workingDirectory, flags.project ?? "."));
  const written = flags.write ? applyPlan(plan) : undefined;
  return flags.json ? JSON.stringify({ ...plan, written }, null, 2) : formatPlan(plan, written);
}

function main() {
  try {
    process.stdout.write(`${runMigration(process.argv.slice(2), process.cwd())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n${error instanceof UsageError ? `${USAGE}\n` : ""}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
