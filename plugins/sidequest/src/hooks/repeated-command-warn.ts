#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord, readStdin, stringField } from './shared/input.js';
import { writeContext } from './shared/output.js';

const STATE_DIR = path.join(os.tmpdir(), 'sidequest-repeated-command-warn');
const WARNING = 'sidequest: you have run this exact command 3 times; if you are waiting on something, run it with run_in_background and let the completion notification wake you — polling burns ~14s and ~60k tokens per call';

type State = {
  command: string;
  count: number;
  lastWarning: number;
};

function normalizedCommand(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return '';
  return stringField(toolInput, 'command').trim().replace(/\s+/g, ' ');
}

function readState(file: string): State | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) return null;
    const command = stringField(parsed, 'command');
    const count = Number(parsed.count);
    const lastWarning = Number(parsed.lastWarning);
    if (!command || !Number.isInteger(count) || count < 1 || !Number.isInteger(lastWarning) || lastWarning < 0) return null;
    return { command, count, lastWarning };
  } catch (_) {
    return null;
  }
}

function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentType = stringField(input, 'agent_type', 'agentType');
  const agentId = stringField(input, 'agent_id', 'agentId');
  const toolName = stringField(input, 'tool_name', 'toolName');
  if (!agentType.startsWith('sidequest-') || !agentId || (toolName !== 'Bash' && toolName !== 'PowerShell')) return;

  const command = normalizedCommand(input);
  if (!command) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, encodeURIComponent(agentId));
  const previous = readState(file);
  const count = previous?.command === command ? previous.count + 1 : 1;
  const lastWarning = previous?.command === command ? previous.lastWarning : 0;
  const warn = count >= 3 && (lastWarning === 0 || count - lastWarning >= 5);
  fs.writeFileSync(file, JSON.stringify({ command, count, lastWarning: warn ? count : lastWarning }));
  if (warn) writeContext('PreToolUse', WARNING);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
