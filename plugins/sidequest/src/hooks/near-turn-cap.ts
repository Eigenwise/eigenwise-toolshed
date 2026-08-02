#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';

const LIMITS = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 } as const;
type Effort = keyof typeof LIMITS;
const COUNTER_DIR = path.join(os.tmpdir(), 'sidequest-near-turn-cap');

function isEffort(value: string): value is Effort {
  return Object.prototype.hasOwnProperty.call(LIMITS, value);
}

function maxTurns(effort: Effort): number {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && raw.trim() !== '') {
    const value = Number(raw.trim());
    if (Number.isInteger(value) && value > 0) return value;
  }
  return LIMITS[effort];
}

function effortFor(input: HookInput, agentType: string): Effort {
  const explicit = stringField(input, 'effort').trim().toLowerCase();
  if (isEffort(explicit)) return explicit;
  const match = agentType.match(/-(low|medium|high|xhigh|max)$/);
  return match && isEffort(match[1] || '') ? match[1] as Effort : 'medium';
}

// Once inside the final band, re-warn every REWARN_EVERY calls: a heads-down
// model routinely blows past a single note, and after the cap the harness
// terminates the run with no chance to commit or report.
const REWARN_EVERY = 4;
const FINAL_BAND_RESERVE = 15;

function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentType = stringField(input, 'agent_type', 'agentType');
  const agentId = stringField(input, 'agent_id', 'agentId');
  if (!agentType.startsWith('sidequest-') || !agentId) return;

  const effort = effortFor(input, agentType);
  const cap = maxTurns(effort);
  const soft = Math.ceil(cap * 0.8);
  const finalBand = Math.max(soft + 1, cap - FINAL_BAND_RESERVE);
  fs.mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = path.join(COUNTER_DIR, encodeURIComponent(agentId));
  let prior = 0;
  let lastFinalWarn = 0;
  try {
    const parts = fs.readFileSync(counterFile, 'utf8').split(/\s+/);
    prior = Number(parts[0]) || 0;
    lastFinalWarn = Number(parts[1]) || 0;
  } catch (_) {}
  const count = prior + 1;

  if (count >= finalBand && (lastFinalWarn === 0 || count - lastFinalWarn >= REWARN_EVERY)) {
    fs.writeFileSync(counterFile, `${count} ${count}`);
    writeContext('PreToolUse', `sidequest: TURN CAP IMMINENT — ${count} tool calls against a ${cap}-turn hard cap. At the cap the harness terminates this executor and uncommitted work is lost with NO report. Stop implementing now: commit verified in-scope work, post a "Continuation checkpoint" comment (commit, files touched, next steps, verify status), then release to todo.`);
    return;
  }
  fs.writeFileSync(counterFile, `${count} ${lastFinalWarn}`);
  // Crossing check, not exact equality: parallel tool calls race this counter's
  // read-modify-write, so a specific value can be skipped entirely.
  if (prior < soft && count >= soft) {
    writeContext('PreToolUse', `sidequest: this executor has made ${count} tool calls, near its ${cap}-turn backstop. Commit or publish any useful completed increment, then finish or release with findings if the briefing is larger than expected.`);
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
