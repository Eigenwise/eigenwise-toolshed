import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The session hooks and the board's close-time cleanup sweep the same trees, so they share one lock
// file. Hooks bundle this module and the MCP server requires it, and both resolve the same path.
function sweepLockFile(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'worktree-sweep.lock');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function lockHolderAlive(file: string): boolean {
  let holder = 0;
  try {
    holder = Number(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return Number.isInteger(holder) && holder > 0 && processAlive(holder);
}

function createSweepLock(file: string): 'acquired' | 'held' | 'unwritable' {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return 'acquired';
  } catch (error: any) {
    return error?.code === 'EEXIST' ? 'held' : 'unwritable';
  }
}

function removeStaleSweepLock(file: string): void {
  try {
    if (!lockHolderAlive(file)) fs.rmSync(file, { force: true });
  } catch (_) {}
}

function releaseSweepLock(file: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true });
  } catch (_) {}
}

// A detached SessionEnd sweep and the next SessionStart sweep (a /clear fires both back to back)
// would otherwise rename the same trees into quarantine and race each other's git worktree repair
// (SQ-51), and a ticket close sweeps its own tree in between. null means a live sweep holds the
// lock. The lock is advisory, so a home it cannot be written in sweeps anyway.
function acquireSweepLock(file: string): (() => void) | null {
  let outcome = createSweepLock(file);
  if (outcome === 'held') {
    removeStaleSweepLock(file);
    outcome = createSweepLock(file);
  }
  if (outcome === 'held') return null;
  return outcome === 'acquired' ? () => releaseSweepLock(file) : () => {};
}

// A held lock skips the sweep instead of waiting for it: whatever the other sweep leaves, the next
// session sweep reaches.
export async function withWorktreeSweepLock(sweep: () => Promise<string[]>): Promise<string[]> {
  const release = acquireSweepLock(sweepLockFile());
  if (!release) return [];
  try {
    return await sweep();
  } finally {
    release();
  }
}
