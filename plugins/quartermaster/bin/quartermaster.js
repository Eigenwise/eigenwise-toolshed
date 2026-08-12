#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { DEFAULT_DAYS, DEFAULT_SESSIONS } = require('../lib/scan.js');
const { mine } = require('../lib/mine.js');
const { applyPermissionAllowlist, enablePermissionAutomation, ruleFor } = require('../lib/permission-allowlist.js');
const { readAvailable, readInstalled, searchAvailable } = require('../lib/catalog.js');
const {
  appendDecision,
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
  quartermaster decisions list
  quartermaster decisions add --title <t> --fingerprint <f> --status applied|rejected|deferred
                          [--kind <k>] [--signal denials|interrupts|corrections|toolErrors|any]
                          [--project <path>] [--detail <text>]
  quartermaster verify [--project <path>]
  quartermaster mark-resupply [--project <path>]
  quartermaster allowlist [--project <path>] [--days <n>] [--sessions <n>]
  quartermaster enable-auto-allowlist [--project <path>]

Everything prints JSON. Defaults: --days ${DEFAULT_DAYS}, --sessions ${DEFAULT_SESSIONS}, project = cwd.
`;

function parseArgs(argv) {
  const options = {
    command: 'help',
    projectPath: process.cwd(),
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
      case '--project': options.projectPath = path.resolve(take()); break;
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
      case '--help': case '-h': options.command = 'help'; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(options.sessions) || options.sessions <= 0) throw new Error('--sessions must be a positive number');
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
      printJson(readDecisions());
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
      for (const blocked of result.blocked) {
        process.stdout.write(`blocked ${blocked.fingerprint}: destructive command after ${blocked.approvals} approvals\n`);
      }
      if (!result.applied) {
        for (const entry of result.eligible.filter((candidate) => !candidate.destructive)) {
          process.stdout.write(`would add ${ruleFor(entry.fingerprint)} after ${entry.approvals} approvals\n`);
        }
        process.stdout.write(`reported only: this project has not run enable-auto-allowlist\n`);
      }
      printJson(result);
      return;
    }
    case 'enable-auto-allowlist':
      printJson({ ok: true, enabled: enablePermissionAutomation(options.projectPath) });
      return;
    // mark-retro is the pre-rename spelling, still accepted so a skill file or note that predates
    // the rename keeps working instead of failing at the last step of a completed pass.
    case 'mark-retro':
    case 'mark-resupply':
      markResupply(options.projectPath);
      printJson({ ok: true, lastResupplyAt: new Date().toISOString() });
      return;
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
