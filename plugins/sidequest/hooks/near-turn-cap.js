#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 };
const COUNTER_DIR = path.join(os.tmpdir(), 'sidequest-near-turn-cap');

function maxTurns(effort) {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && String(raw).trim() !== '') {
    const value = Number(String(raw).trim());
    if (Number.isInteger(value) && value > 0) return value;
  }
  return LIMITS[String(effort || '').trim().toLowerCase()] || LIMITS.medium;
}

function effortFor(input, agentType) {
  const explicit = String(input.effort || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LIMITS, explicit)) return explicit;
  const match = agentType.match(/-(low|medium|high|xhigh|max)$/);
  return match ? match[1] : 'medium';
}

// No subagent exemption: this hook's audience IS the executor (it warns a
// sidequest exec near its turn backstop); a blanket exemption makes it dead code.
function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') return;

  const agentType = String(input.agent_type || input.agentType || '');
  const agentId = String(input.agent_id || input.agentId || '');
  if (!agentType.startsWith('sidequest-') || !agentId) return;

  const effort = effortFor(input, agentType);
  const threshold = Math.ceil(maxTurns(effort) * 0.8);
  fs.mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = path.join(COUNTER_DIR, encodeURIComponent(agentId));
  const prior = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) || 0 : 0;
  const count = prior + 1;
  fs.writeFileSync(counterFile, String(count));
  if (count !== threshold) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `sidequest: this executor has made ${count} tool calls, near its ${maxTurns(effort)}-turn backstop. Commit or publish any useful completed increment, then finish or release with findings if the briefing is larger than expected.`,
    },
  }));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
