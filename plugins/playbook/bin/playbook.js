#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_DAYS, DEFAULT_SESSIONS, slugForProject } = require('../lib/scan.js');
const { formatReport } = require('../lib/report.js');
const { mine, writeResults } = require('../lib/mine.js');
const { verifySalvage } = require('../lib/verify.js');

const USAGE = `playbook - mine recent Claude Code transcripts for work that keeps getting redone

Usage:
  playbook mine [options]
  playbook salvage --dir <report-dir> --id <salvage-id> --to <file>
  playbook verify  --dir <report-dir> [--id <salvage-id>] [--run]

mine options:
  --project <path>     Project whose transcripts to scan (default: cwd)
  --slug <slug>        Scan this transcript directory instead of deriving one from --project
  --days <n>           Day cutoff (default: ${DEFAULT_DAYS})
  --sessions <n>       Session cap, the tighter of the two limits wins (default: ${DEFAULT_SESSIONS})
  --all-projects       Scan every project, not just this one (much slower)
  --no-subagents       Skip subagent transcripts (they are usually the larger half)
  --floor <n>          Drop findings scoring below this (default: 25)
  --out <dir>          Where to write findings.json, report.md, and salvage/
  --format text|json   stdout format (default: text)

verify options:
  --run                Actually execute the recorded command. Off by default: the command comes
                       from a transcript and is replayed verbatim apart from the script path.
`;

function parseArgs(argv) {
  const options = {
    command: 'mine',
    projectPath: process.cwd(),
    slug: null,
    days: DEFAULT_DAYS,
    sessions: DEFAULT_SESSIONS,
    allProjects: false,
    includeSubagents: true,
    floor: 25,
    outputDir: null,
    format: 'text',
    id: null,
    to: null,
    run: false,
  };

  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('-')) options.command = rest.shift();

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const next = rest[index + 1];
    const take = () => {
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--project': options.projectPath = path.resolve(take()); break;
      case '--slug': options.slug = take(); break;
      case '--days': options.days = Number(take()); break;
      case '--sessions': options.sessions = Number(take()); break;
      case '--all-projects': options.allProjects = true; break;
      case '--no-subagents': options.includeSubagents = false; break;
      case '--floor': options.floor = Number(take()); break;
      case '--out': case '--dir': options.outputDir = path.resolve(take()); break;
      case '--format': options.format = take(); break;
      case '--id': options.id = take(); break;
      case '--to': options.to = path.resolve(take()); break;
      case '--run': options.run = true; break;
      case '--help': case '-h': options.command = 'help'; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(options.sessions) || options.sessions <= 0) throw new Error('--sessions must be a positive number');
  if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json');
  return options;
}

function defaultOutputDir(options) {
  const slug = options.slug ?? slugForProject(options.projectPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(os.tmpdir(), 'playbook', `${slug}-${stamp}`);
}

function loadReport(dir) {
  const file = path.join(dir, 'findings.json');
  if (!fs.existsSync(file)) throw new Error(`No findings.json in ${dir}. Run \`playbook mine --out ${dir}\` first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function salvageEntry(dir, report, id) {
  const entry = report.salvage.find((item) => item.id === id);
  if (!entry) throw new Error(`No salvage entry ${id}. Available: ${report.salvage.map((item) => item.id).join(', ') || 'none'}`);
  const body = path.join(dir, 'salvage', `${entry.id}-${entry.basename}`);
  const recorded = `${body}.recorded-stdout.txt`;
  return {
    ...entry,
    content: fs.readFileSync(body, 'utf8'),
    proof: entry.proof ? { ...entry.proof, stdout: fs.existsSync(recorded) ? fs.readFileSync(recorded, 'utf8') : '' } : null,
  };
}

async function runMine(options) {
  const result = await mine(options);
  const outputDir = options.outputDir ?? defaultOutputDir(options);
  const report = formatReport(result);
  const { findingsFile } = writeResults(result, outputDir);
  const reportFile = path.join(outputDir, 'report.md');
  fs.writeFileSync(reportFile, report, 'utf8');

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify({ outputDir, findingsFile, reportFile, window: result.window, totals: result.totals, findings: result.findings }, null, 2)}\n`);
    return;
  }
  process.stdout.write(report);
  process.stdout.write(`\nReport:   ${reportFile}\nFindings: ${findingsFile}\n`);
  if (result.salvage.length) process.stdout.write(`Salvaged: ${path.join(outputDir, 'salvage')} (${result.salvage.length} file(s))\n`);
}

function runSalvage(options) {
  if (!options.outputDir) throw new Error('salvage needs --dir <report-dir>');
  if (!options.id) throw new Error('salvage needs --id <salvage-id>');
  if (!options.to) throw new Error('salvage needs --to <file>');
  const entry = salvageEntry(options.outputDir, loadReport(options.outputDir), options.id);
  fs.mkdirSync(path.dirname(options.to), { recursive: true });
  fs.writeFileSync(options.to, entry.content, 'utf8');
  process.stdout.write(`Wrote ${entry.basename} (${Buffer.byteLength(entry.content, 'utf8')} bytes) to ${options.to}\n`);
  if (entry.truncated) process.stdout.write('WARNING: the recorded body exceeded the salvage cap and is truncated. Do not ship it without reading it.\n');
}

function runVerify(options) {
  if (!options.outputDir) throw new Error('verify needs --dir <report-dir>');
  const report = loadReport(options.outputDir);
  const ids = options.id ? [options.id] : report.salvage.map((item) => item.id);
  if (!ids.length) {
    process.stdout.write('Nothing to verify: this run salvaged no scripts.\n');
    return;
  }
  for (const id of ids) {
    const entry = salvageEntry(options.outputDir, report, id);
    const result = verifySalvage(entry, { execute: options.run, cwd: options.projectPath });
    process.stdout.write(`\n${result.id} ${result.basename}\n`);
    process.stdout.write(`  parse:   ${result.parse.checked ? (result.parse.ok ? 'ok' : `FAILED\n${result.parse.reason.split('\n').map((line) => `           ${line}`).join('\n')}`) : `not checked (${result.parse.reason})`}\n`);
    if (result.command) process.stdout.write(`  command: ${result.command}\n`);
    process.stdout.write(`  run:     ${result.execution.status}${result.execution.match ? ` / ${result.execution.match}` : ''}\n`);
    const detail = result.execution.detail ?? '';
    if (detail) process.stdout.write(`${detail.split('\n').map((line) => `           ${line}`).join('\n')}\n`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'help': process.stdout.write(USAGE); return;
    case 'mine': await runMine(options); return;
    case 'salvage': runSalvage(options); return;
    case 'verify': runVerify(options); return;
    default: throw new Error(`Unknown command: ${options.command}\n\n${USAGE}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`playbook failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { defaultOutputDir, main, parseArgs, USAGE };
