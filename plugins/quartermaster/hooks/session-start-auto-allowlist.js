#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { permissionAutomationEnabled } = require('../lib/permission-allowlist.js');
const { applyLearningCache, refreshLearningCache } = require('../lib/allowlist-learning-cache.js');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function projectDirectory(data) {
  return process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
}

function printLearningResult(result = { additions: [], blocked: [] }) {
  for (const addition of result.additions) {
    process.stdout.write(`quartermaster auto-allowlist: added ${addition.fingerprint} after ${addition.approvals} approvals\n`);
  }
  for (const blocked of result.blocked) {
    process.stdout.write(`quartermaster auto-allowlist: blocked ${blocked.fingerprint} because ${blocked.vetoReason ?? 'it is destructive'}\n`);
  }
}

async function main() {
  const data = readStdin();
  if (data.source && data.source !== 'startup') return;
  const projectDir = projectDirectory(data);
  if (!permissionAutomationEnabled(projectDir)) return;
  const result = applyLearningCache(projectDir) ?? undefined;
  process.stdout.write(`${JSON.stringify({ async: true, asyncTimeout: 120_000 })}\n`);
  printLearningResult(result);
  await refreshLearningCache(projectDir);
}

main().catch(() => process.exit(0));
