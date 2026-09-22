#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { DEFAULT_DAYS, DEFAULT_SESSIONS } = require('../lib/scan.js');
const { mine } = require('../lib/mine.js');
const { applyPermissionAllowlist, enablePermissionAutomation, ruleFor } = require('../lib/permission-allowlist.js');
const { readAvailable, readInstalled, searchAvailable } = require('../lib/catalog.js');
const { DEFAULT_MAX, PrerequisiteError, crapReport, formatReport } = require('../lib/crap.js');
const {
  appendDecision,
  declineResupply,
  markResupply,
  readDecisions,
  statusFor,
  verifyDecisions,
} = require('../lib/state.js');

const USAGE = `quartermaster - mine recent Claude Code sessions for what would make the work easier

Usage:
  quartermaster mine [--project <path>] [--days <n>] [--sessions <n>] [--all-projects] [--no-subagents]
  quartermaster status [--project <path>]
  quartermaster catalog [--query <terms>] [--installed]
  quartermaster decisions list [--project <path>]
  quartermaster decisions add --title <t> --fingerprint <f> --status applied|rejected|deferred
                          [--kind <k>] [--signal denials|interrupts|corrections|toolErrors|any]
                          [--project <path>] [--detail <text>]
  quartermaster verify [--project <path>]
  quartermaster mark-resupply [--project <path>]
  quartermaster decline-resupply [--project <path>]
  quartermaster allowlist [--project <path>] [--days <n>] [--sessions <n>] [--blocked]
  quartermaster enable-auto-allowlist [--project <path>]
  quartermaster crap [--project <path>] [--lcov <path>] [--complexity <lizard.csv>]
                     [--coverage-command "<cmd>"] [--json]

Everything prints JSON except crap, which prints one line per offender plus a summary unless --json.
Defaults: --days ${DEFAULT_DAYS}, --sessions ${DEFAULT_SESSIONS}, project = cwd.
Blocked allowlist candidates are summarized by default; --blocked includes up to 25 detailed entries.
crap reads .claude/quartermaster/crap.json (coverageCommand, lcov, sources, exclude, base), needs
lizard (lizard on PATH, else uvx lizard, else pipx run lizard), and checks only changed or new functions
at the fixed CRAP threshold ${DEFAULT_MAX}. It exits 0 pass, 1 functions at or above ${DEFAULT_MAX},
2 unverified measurement (lizard or coverage missing, or coverage command failed).
crap measures .tsx and .jsx with lizard's TypeScript reader, not its TSX one, on both sides of the base
comparison, because the TSX reader loses brace balance on ordinary JSX and folds the functions below a
tag into it. Every offender line for those files names its measurement (source=lizard-typescript), and
--json carries source per function.
crap's --project only names where the config is read; it is not the tree measured. When cwd is inside
that project or a linked worktree of it, or --project is omitted, the coverage command, lcov, lizard
scan, and base comparison all run against cwd's git toplevel, and without --project the config comes
from there too. A --project in another repository is measured where it points. crap prints the root it
measured. The coverage command gets QUARTERMASTER_COVERAGE_DIR, a fresh directory per run: writing
lcov.info there keeps concurrent runs on one checkout apart. A command that exits 0 but writes neither
that file nor a fresh coverage/lcov.info exits 2 rather than scoring stale coverage.
`;

const BLOCKED_SUMMARY_LIMIT = 5;
const BLOCKED_DETAIL_LIMIT = 25;
const BLOCKED_COMMAND_LIMIT = 160;

function truncateCommand(command) {
  return command.length <= BLOCKED_COMMAND_LIMIT ? command : `${command.slice(0, BLOCKED_COMMAND_LIMIT - 1)}…`;
}

function blockedReason(entry) {
  if (entry.vetoReason) return `vetoed as too broad a rule (${entry.vetoReason})`;
  return `sighted destructive command ${JSON.stringify(truncateCommand(entry.destructiveCommand ?? ''))}`;
}

function sortedBlocked(entries) {
  return [...entries].sort((left, right) => right.approvals - left.approvals || left.fingerprint.localeCompare(right.fingerprint));
}

function blockedTool(fingerprint) {
  return /^permission:([^:]+)/.exec(fingerprint)?.[1] ?? 'unknown';
}

function blockedReportEntry(entry) {
  return { fingerprint: entry.fingerprint, approvals: entry.approvals, reason: blockedReason(entry) };
}

function blockedReport(entries, includeDetails) {
  const sorted = sortedBlocked(entries);
  const byTool = {};
  for (const entry of sorted) {
    const tool = blockedTool(entry.fingerprint);
    byTool[tool] = (byTool[tool] ?? 0) + 1;
  }
  const report = {
    total: sorted.length,
    byTool,
    top: sorted.slice(0, BLOCKED_SUMMARY_LIMIT).map(blockedReportEntry),
  };
  if (includeDetails) {
    report.details = sorted.slice(0, BLOCKED_DETAIL_LIMIT).map(blockedReportEntry);
    if (sorted.length > BLOCKED_DETAIL_LIMIT) report.omitted = sorted.length - BLOCKED_DETAIL_LIMIT;
  }
  return { report, sorted };
}

function printBlockedReport(entries, includeDetails) {
  const { report, sorted } = blockedReport(entries, includeDetails);
  if (!report.total) return report;
  const counts = Object.entries(report.byTool).map(([tool, count]) => `${tool}: ${count}`).join(', ');
  const displayed = includeDetails ? sorted.slice(0, BLOCKED_DETAIL_LIMIT) : sorted.slice(0, BLOCKED_SUMMARY_LIMIT);
  process.stdout.write(`blocked ${report.total} fingerprint${report.total === 1 ? '' : 's'} by tool (${counts})\n`);
  for (const entry of displayed) {
    process.stdout.write(`blocked ${entry.fingerprint}: ${blockedReason(entry)} after ${entry.approvals} approvals\n`);
  }
  if (includeDetails && report.omitted) process.stdout.write(`blocked detail capped at ${BLOCKED_DETAIL_LIMIT}; ${report.omitted} more omitted\n`);
  return report;
}

function permissionReport(result, includeBlockedDetails) {
  return {
    projectDir: result.projectDir,
    additions: result.additions,
    blocked: blockedReport(result.blocked, includeBlockedDetails).report,
    applied: result.applied,
    scanned: result.scanned,
  };
}

function parseArgs(argv) {
  const options = {
    command: 'help',
    projectPath: process.cwd(),
    projectPathGiven: false,
    days: DEFAULT_DAYS,
    sessions: DEFAULT_SESSIONS,
    allProjects: false,
    includeSubagents: true,
    query: null,
    installed: false,
    title: null,
    fingerprint: null,
    status: null,
    kind: null,
    signal: 'any',
    detail: null,
    includeBlocked: false,
    max: null,
    ratchet: null,
    lcov: null,
    complexity: null,
    coverageCommand: null,
    json: false,
  };

  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('-')) options.command = rest.shift();
  if (options.command === 'decisions' && rest.length && !rest[0].startsWith('-')) {
    options.command = `decisions-${rest.shift()}`;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const take = () => {
      const next = rest[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--project': options.projectPath = path.resolve(take()); options.projectPathGiven = true; break;
      case '--days': options.days = Number(take()); break;
      case '--sessions': options.sessions = Number(take()); break;
      case '--all-projects': options.allProjects = true; break;
      case '--no-subagents': options.includeSubagents = false; break;
      case '--query': options.query = take(); break;
      case '--installed': options.installed = true; break;
      case '--title': options.title = take(); break;
      case '--fingerprint': options.fingerprint = take(); break;
      case '--status': options.status = take(); break;
      case '--kind': options.kind = take(); break;
      case '--signal': options.signal = take(); break;
      case '--detail': options.detail = take(); break;
      case '--blocked': options.includeBlocked = true; break;
      case '--max': options.max = Number(take()); break;
      case '--ratchet': options.ratchet = take(); break;
      case '--lcov': options.lcov = take(); break;
      case '--complexity': options.complexity = take(); break;
      case '--coverage-command': options.coverageCommand = take(); break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.command = 'help'; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(options.sessions) || options.sessions <= 0) throw new Error('--sessions must be a positive number');
  if (options.max !== null && (!Number.isFinite(options.max) || options.max <= 0)) throw new Error('--max must be a positive number');
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runDecisionsAdd(options) {
  if (!options.title) throw new Error('decisions add needs --title');
  if (!options.fingerprint) throw new Error('decisions add needs --fingerprint');
  if (!['applied', 'rejected', 'deferred'].includes(options.status ?? '')) {
    throw new Error('decisions add needs --status applied|rejected|deferred');
  }
  const entry = appendDecision({
    projectDir: options.projectPath,
    kind: options.kind ?? 'other',
    title: options.title,
    fingerprint: options.fingerprint,
    status: options.status,
    signal: options.signal,
    detail: options.detail,
  });
  printJson(entry);
}

function runCrap(options) {
  let report;
  try {
    report = crapReport({
      projectDir: options.projectPath,
      cwd: process.cwd(),
      projectPathGiven: options.projectPathGiven,
      max: options.max,
      ratchet: options.ratchet,
      lcov: options.lcov,
      complexity: options.complexity,
      coverageCommand: options.coverageCommand,
    });
  } catch (error) {
    if (!(error instanceof PrerequisiteError)) throw error;
    process.stderr.write(`quartermaster crap: ${error.message}\n`);
    if (error.hint) process.stderr.write(`${error.hint}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`quartermaster crap: measured ${report.root}\n`);
  if (options.json) printJson(report);
  else process.stdout.write(formatReport(report));
  process.exitCode = report.failures.length ? 1 : 0;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'mine':
      printJson(await mine(options));
      return;
    case 'status':
      printJson(statusFor(options.projectPath));
      return;
    case 'catalog':
      if (options.installed) printJson(readInstalled());
      else if (options.query) printJson(searchAvailable(options.query));
      else printJson({ available: readAvailable().length, installed: readInstalled().length, hint: 'use --query <terms> to search, --installed to list installs' });
      return;
    case 'decisions-list':
      printJson(readDecisions(process.env, options.projectPathGiven ? options.projectPath : null));
      return;
    case 'decisions-add':
      runDecisionsAdd(options);
      return;
    case 'verify':
      printJson(verifyDecisions(options.projectPath));
      return;
    case 'allowlist': {
      const result = await applyPermissionAllowlist(options);
      for (const addition of result.additions) {
        process.stdout.write(`added ${addition.fingerprint} after ${addition.approvals} approvals\n`);
      }
      printBlockedReport(result.blocked, options.includeBlocked);
      if (!result.applied) {
        for (const entry of result.eligible.filter((candidate) => !candidate.destructive)) {
          process.stdout.write(`would add ${ruleFor(entry.fingerprint)} after ${entry.approvals} approvals\n`);
        }
        process.stdout.write(`reported only: this project has not run enable-auto-allowlist\n`);
      }
      printJson(permissionReport(result, options.includeBlocked));
      return;
    }
    case 'crap':
      runCrap(options);
      return;
    case 'enable-auto-allowlist':
      printJson({ ok: true, enabled: enablePermissionAutomation(options.projectPath) });
      return;
    case 'mark-resupply': {
      const state = markResupply(options.projectPath);
      printJson({ ok: true, lastResupplyAt: state.lastResupplyAt });
      return;
    }
    case 'decline-resupply': {
      const state = declineResupply(options.projectPath);
      printJson({
        ok: true,
        lastDeclinedAt: state.lastDeclinedAt,
        consecutiveDeclines: state.consecutiveDeclines,
        lastResupplyAt: state.lastResupplyAt,
      });
      return;
    }
    default:
      throw new Error(`Unknown command: ${options.command}\n\n${USAGE}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`quartermaster failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, USAGE };
