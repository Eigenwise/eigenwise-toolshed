import fs from 'node:fs';
import { canonicalExecutorName } from '../../lib/exec-names.js';

export type HookInput = Record<string, unknown>;

export function isRecord(value: unknown): value is HookInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readStdin(): HookInput | null {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    // Host namespaces identify plugin types; board ownership retains the stable executor name.
    for (const field of ['agent_type', 'agentType', 'subagent_type']) {
      const executor = parsed[field];
      if (typeof executor === 'string') parsed[field] = canonicalExecutorName(executor);
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

export function stringField(input: HookInput, ...names: string[]): string {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return '';
}

export function isSubagent(input: HookInput): boolean {
  return ['agent_id', 'agentId', 'agent_type', 'agentType']
    .some((name) => {
      const identity = String(input[name] || '').trim().toLowerCase();
      return identity && identity !== 'main' && identity !== 'main-thread';
    });
}
