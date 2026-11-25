#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatAuditTable } from "./audit-table.mjs";
import { parseFlags, UsageError } from "./command-line.mjs";
import { auditRulesDirectory } from "./rule-audit.mjs";

const USAGE = "usage: audit-rules.mjs [--rules <dir>] [--root <project>] [--file <rule file>] [--table]";

export function runAudit(argv, workingDirectory) {
  if (typeof path.posix.matchesGlob !== "function") {
    throw new Error("the audit needs Node 22.5 or later (path.matchesGlob). Skip it, or install a newer Node.");
  }
  const flags = parseFlags(argv, { valueFlags: ["--rules", "--root", "--file"], booleanFlags: ["--table"] });
  const rulesDirectory = path.resolve(workingDirectory, flags.rules ?? ".claude/rules");
  const projectRoot = path.resolve(workingDirectory, flags.root ?? path.join(rulesDirectory, "..", ".."));
  const onlyFile = flags.file === undefined ? undefined : path.resolve(workingDirectory, flags.file);
  const report = auditRulesDirectory({ rulesDirectory, projectRoot, onlyFile });
  const output = flags.table ? formatAuditTable(report) : JSON.stringify(report, null, 2);
  return { output, exitCode: report.errorCount > 0 ? 1 : 0 };
}

function main() {
  try {
    const { output, exitCode } = runAudit(process.argv.slice(2), process.cwd());
    process.stdout.write(`${output}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n${error instanceof UsageError ? `${USAGE}\n` : ""}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
