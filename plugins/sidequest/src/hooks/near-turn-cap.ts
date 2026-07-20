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

function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentType = stringField(input, 'agent_type', 'agentType');
  const agentId = stringField(input, 'agent_id', 'agentId');
  if (!agentType.startsWith('sidequest-') || !agentId) return;

  const effort = effortFor(input, agentType);
  const threshold = Math.ceil(maxTurns(effort) * 0.8);
  fs.mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = path.join(COUNTER_DIR, encodeURIComponent(agentId));
  const prior = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) || 0 : 0;
  const count = prior + 1;
  fs.writeFileSync(counterFile, String(count));
  if (count !== threshold) return;

  writeContext('PreToolUse', `sidequest: this executor has made ${count} tool calls, near its ${maxTurns(effort)}-turn backstop. Commit or publish any useful completed increment, then finish or release with findings if the briefing is larger than expected.`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
