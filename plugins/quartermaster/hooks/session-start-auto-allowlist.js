#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { applyPermissionAllowlist, permissionAutomationEnabled } = require('../lib/permission-allowlist.js');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function main() {
  const data = readStdin();
  if (data.source && data.source !== 'startup') return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
  if (!permissionAutomationEnabled(projectDir)) return;
  const result = await applyPermissionAllowlist({ projectPath: projectDir });
  for (const addition of result.additions) {
    process.stdout.write(`quartermaster auto-allowlist: added ${addition.fingerprint} after ${addition.approvals} approvals\n`);
  }
  for (const blocked of result.blocked) {
    process.stdout.write(`quartermaster auto-allowlist: blocked ${blocked.fingerprint} because it is destructive\n`);
  }
}

main().catch(() => process.exit(0));
