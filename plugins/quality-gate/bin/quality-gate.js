#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { measureFiles } from '../lib/measure.mjs';
import { crapReport, formatCrapReport, writeReceipt } from '../lib/crap.mjs';
import { projectRoot } from '../lib/crap-inputs.mjs';

const HELP = `Usage:
  quality-gate crap [--project <root>] [--base <revision>] [--lcov <path>]
                    [--coverage-command "<command>"] [--cc-only] [--json]
                    [--complexity <lizard.csv>]
  quality-gate measure --project <root> --base <revision> --coverage <V8-directory> <files...>

crap reads .claude/quality-gate/crap.json (falls back to .claude/quartermaster/crap.json).
--project selects the tree measured, including a linked worktree; without it the cwd's Git root is used.
JS/TS runtime functions use the TypeScript AST, PHP/Vue use lizard. Python is informational-unverified
until its adapter ships. No JavaScript or TypeScript lizard row is scored, including --complexity input.
Only new and modified-raised functions must score strictly below 6. Legacy-unchanged rows are informational.
--base defaults to the local develop, main or master branch; HEAD means score all selected bodies.
--cc-only checks the complexity floor without running coverage; it cannot prove a full CRAP pass.
--lcov requires a sibling <lcov>.sources.json SHA-256 map from the same-byte coverage capture.
--coverage-command captures source hashes and requires fresh LCOV. It sets QUALITY_GATE_COVERAGE_DIR
and QUARTERMASTER_COVERAGE_DIR to an empty isolated directory; write lcov.info there.
Vitest projects need their own provider's LCOV; raw NODE_V8_COVERAGE misses vite-node modules.
Exit codes for crap: 0 passed/nothing to score/informational-only, 1 score failure, 2 unverified/prerequisite.
Receipts, including unverified runs, go to .claude/quality-gate/receipts/<head-sha>.json.
--ratchet is deprecated; use --base. The threshold is fixed at 6; remove --max or config max overrides.
`;

function argumentsForCommand() {
  const options = Object.fromEntries(['project', 'base', 'coverage', 'lcov', 'coverage-command', 'complexity', 'ratchet', 'max'].map((name) => [name, { type: 'string' }]));
  Object.assign(options, Object.fromEntries(['cc-only', 'json', 'help'].map((name) => [name, { type: 'boolean' }])));
  return parseArgs({ allowPositionals: true, options });
}

async function runMeasure(values, files) {
  if (![values.base, values.coverage, files.length].every(Boolean)) throw new Error('Usage: quality-gate measure --project <root> --base <revision> --coverage <V8-directory> <files...>. Supply the missing arguments, or run quality-gate --help.');
  const report = await measureFiles(files, { projectRoot: path.resolve(values.project || process.cwd()), base: values.base, coverageDirectory: path.resolve(values.coverage) });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = Number(report.failures.length > 0 || report.unverified.length > 0);
}

async function capturedReport(values) {
  try {
    return await crapReport({ ...values, ccOnly: values['cc-only'], coverageCommand: values['coverage-command'] });
  } catch (error) {
    const unverified = [{ relativePath: '<gate>', line: 1, name: 'prerequisite', unverified: error.message }];
    return { root: projectRoot(values.project || process.cwd()), base: null, files: {}, metrics: [], changedMetrics: [], unverified, failures: [], warnings: [], checked: 0, max: 6, exitCode: 2, verdict: 'unverified', ccOnly: Boolean(values['cc-only']) };
  }
}

async function runCrap(values, files) {
  if (files.length) throw new Error('crap takes no positional files. Set sources in .claude/quality-gate/crap.json.');
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
