import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SessionState = Record<string, unknown>;

export function sessionStateFile(prefix: string, sessionId: string): string {
  const home = process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'tmp', 'state', `${prefix}-${encodeURIComponent(sessionId)}.json`);
}

export function readSessionState(file: string): SessionState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SessionState
      : {};
  } catch (_) {
    return {};
  }
}

export function writeSessionState(file: string, state: SessionState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}
