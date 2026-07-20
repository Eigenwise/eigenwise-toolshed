import fs from 'node:fs';

export type HookInput = Record<string, unknown>;

export function isRecord(value: unknown): value is HookInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readStdin(): HookInput | null {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
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
