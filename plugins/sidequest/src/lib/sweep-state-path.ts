import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from './kernel/worktree.js';

export function stateDirectory(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'sweep-reports');
}

export function reportFile(cwd: string): string {
  const key = crypto.createHash('sha1').update(canonicalPath(cwd || '.')).digest('hex').slice(0, 16);
  return path.join(stateDirectory(), `${key}.json`);
}
