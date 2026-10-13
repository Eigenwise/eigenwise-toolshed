#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { markOffered, statusFor } = require('../lib/state.js');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function offerMessage(status) {
  return `quartermaster: ${status.unanalyzedSessions} sessions and ${status.frictionEvents} friction events since the last resupply. Want a focused resupply round for your development system, setup, tooling, or workflow? Run /quartermaster:resupply when ready. To decline, run node "${'${CLAUDE_PLUGIN_ROOT}'}/bin/quartermaster.js" decline-resupply --project "${'${CLAUDE_PROJECT_DIR}'}" to back off this offer without clearing the evidence window.`;
}

function main() {
  const data = readStdin();
  if (data.stop_hook_active || !data.session_id) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
  const status = statusFor(projectDir);
  if (!status.shouldOffer || status.offeredSessionIds.includes(data.session_id)) return;

  markOffered(projectDir, data.session_id);
  process.stdout.write(JSON.stringify({ systemMessage: offerMessage(status) }));
}

try {
  main();
} catch {
  process.exit(0);
}
