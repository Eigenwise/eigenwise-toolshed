#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { measureFiles } from '../lib/measure.mjs';
import { crapReport, formatCrapReport, writeReceipt } from '../lib/crap.mjs';
import { projectRoot } from '../lib/crap-inputs.mjs';
import { PYTHON_POLICIES, DEFAULT_PYTHON_POLICY } from '../lib/python.mjs';

const HELP = `Usage:
  quality-gate crap [--project <root>] [--base <revision>] [--lcov <path>]
                    [--coverage-command "<command>"] [--cc-only] [--json]
                    [--complexity <lizard.csv>] [--python-policy <policy>] [--source <path>]...
  quality-gate measure [--project <root>] [--base <revision>] --coverage <V8-directory>
                       [--new-external-file <absolute path>]... [files...]

measure requires --base for repository files. Explicit new external .js/.cjs/.mjs files
need no Git repository or base; every owned body is enforced. Declarations must be normalized,
canonical regular files outside --project, with strict UTF-8 (BOM offsets unsupported).
External rows include admission=external-new, absolute identity, raw SHA-256 and evaluator versions.
Capture children through inherited NODE_OPTIONS with the canonical lib/core.mjs file URL, plus QUALITY_GATE_V8_CAPTURE.
In the inspected Claude Code 2.1.295, a direct worktree-isolated Bash startup assignment NODE_OPTIONS=--import=<url>
followed by a Node-family command is refused by the host guard (startup code cannot be shown not to be Git); no shipped
capture-launch command supports that exact boundary. Stop after that actual refusal; missing measurements stay UNVERIFIED.

crap reads .claude/quality-gate/crap.json (falls back to .claude/quartermaster/crap.json).
--project selects the tree measured, including a linked worktree; without it the cwd's Git root is used.
--source <path> is repeatable and narrows configured/default sources to files or directories relative to --project; exclusions still apply.
JS/TS runtime functions use the TypeScript AST, PHP/Vue use lizard. Python uses the versioned
stdlib AST adapter through python3 or py -3 (no radon dependency), with qualified oracle rows. No JavaScript or TypeScript lizard row is scored, including --complexity input.
Invalid UTF-8 and Python syntax/surrogate errors leave per-file informational UNVERIFIED rows; other files are still measured.
--python-policy (config pythonPolicy) explicitly selects ${PYTHON_POLICIES.join(" or ")}; default ${DEFAULT_PYTHON_POLICY}.
config pythonOracles optionally supplies exact {file, name, reason} entries as an authoritative allowlist.
Absent collection uses source-name rules; [] qualifies no oracles. Fixtures/setup always take precedence.
The native policy counts ordinary assertions without traversing them; source-named test_* or explicitly selected exact helper oracles
traverse predicates/messages without assert surcharge. Unselected helpers stay ordinary.
Nested class bodies do not charge enclosing native-policy bodies; methods and lambdas remain independently owned.
Every new or complexity-raised owned body must score strictly below 6 with measured coverage.
Comments and formatting count; equal/lowered complexity legacy edits are informational.
Untouched bodies and independently edited nested bodies do not charge their parents.
--base defaults to the local develop, main or master branch; HEAD means score all selected bodies.
With a base, only selected files that differ from it or are untracked are parsed.
DUPLICATE? and CALLERS OPEN are informational reuse signals (also in --json signals).
They use JS/TS/Python name regexes, never affect the verdict, and also run with --cc-only.
--cc-only checks the complexity floor without running coverage; it cannot prove a full CRAP pass.
--lcov overrides both isolated command output and config lcov. Config lcov is a fallback
behind fresh isolated command output, then coverage/lcov.info when unset.
Without a command, existing LCOV requires a sibling <lcov>.sources.json SHA-256 map
from the same-byte coverage capture.
--coverage-command captures source hashes and requires fresh LCOV. It sets QUALITY_GATE_COVERAGE_DIR
and QUARTERMASTER_COVERAGE_DIR to an empty isolated directory; write lcov.info there.
$VAR, \${VAR} and %VAR% in the command expand before it runs, on every platform.
Existing explicit or fallback output must be rewritten during the command. Missing or
invalid selected output stays unverified; it never silently selects a stale fallback.
Vitest projects need their own provider's LCOV; raw NODE_V8_COVERAGE misses vite-node modules.
Exit codes for crap: 0 passed/nothing to score/informational-only, 1 score failure, 2 unverified/prerequisite.
Receipts, including unverified runs, go to .claude/quality-gate/receipts/<head-sha>.json.
--ratchet is deprecated; use --base. The threshold is fixed at 6; remove --max or config max overrides.
`;

function argumentsForCommand() {
  const options = Object.fromEntries(['project', 'base', 'coverage', 'lcov', 'coverage-command', 'complexity', 'ratchet', 'max', 'python-policy'].map((name) => [name, { type: 'string' }]));
  Object.assign(options, Object.fromEntries(['cc-only', 'json', 'help'].map((name) => [name, { type: 'boolean' }])));
  options.source = { type: 'string', multiple: true };
  options['new-external-file'] = { type: 'string', multiple: true };
  const parsed = parseArgs({ allowPositionals: true, options });
  if (parsed.values.source && parsed.positionals[0] !== 'crap') throw new Error('--source belongs to crap only');
  if (parsed.values['new-external-file'] && parsed.positionals[0] !== 'measure') throw new Error('--new-external-file belongs to measure only');
  return parsed;
}

async function runMeasure(values, files) {
  const externalNewFiles = values['new-external-file'] ?? [];
  if (!values.coverage) throw new Error('Usage: quality-gate measure requires --coverage <V8-directory>; run quality-gate --help for capture instructions');
  if (files.length + externalNewFiles.length === 0) throw new Error('measure requires repository files or --new-external-file <absolute path>');
  const report = await measureFiles(files, { projectRoot: path.resolve(values.project || process.cwd()), base: values.base, coverageDirectory: path.resolve(values.coverage), externalNewFiles });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = Number(report.failures.length + report.unverified.length > 0);
}

async function capturedReport(values) {
  try {
    return await crapReport({ ...values, ccOnly: values['cc-only'], coverageCommand: values['coverage-command'], pythonPolicy: values['python-policy'] });
  } catch (error) {
    const unverified = [{ relativePath: '<gate>', line: 1, name: 'prerequisite', unverified: error.message }];
    return { root: projectRoot(values.project || process.cwd()), base: null, files: {}, metrics: [], changedMetrics: [], signals: [], unverified, failures: [], warnings: [], checked: 0, max: 6, exitCode: 2, verdict: 'unverified', ccOnly: Boolean(values['cc-only']) };
  }
}

async function runCrap(values, files) {
  if (files.length) throw new Error('crap takes no positional files. Use --source <path> or set sources in .claude/quality-gate/crap.json.');
  if (values.coverage) throw new Error('crap consumes LCOV. Use --lcov, or use measure for a V8 coverage directory.');
  const report = await capturedReport(values);
  report.receipt = writeReceipt(report);
  for (const warning of report.warnings) process.stderr.write(`quality-gate crap: ${warning}\n`);
  process.stderr.write(`quality-gate crap: measured ${report.root}\n`);
  process.stdout.write(values.json ? JSON.stringify(report) + '\n' : formatCrapReport(report));
  process.exitCode = report.exitCode;
}

async function main() {
  const { values, positionals } = argumentsForCommand();
  const [command, ...files] = positionals;
  if (values.help || command === 'help') return process.stdout.write(HELP);
  if (command === 'measure') return runMeasure(values, files);
  if (command === 'crap') return runCrap(values, files);
  throw new Error('Choose crap or measure. Run quality-gate --help for usage.');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`quality-gate: ${error.message}\n`);
  process.exitCode = process.argv[2] === 'measure' ? 1 : 2;
}
