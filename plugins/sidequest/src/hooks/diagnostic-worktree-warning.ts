import fs from 'node:fs';
import path from 'node:path';
import { stringField, type HookInput } from './shared/input.js';

const WARNING = "sidequest: foreign agent worktrees detected; diagnostics under `.claude/worktrees/agent-*` are stale and false when their path is gone from disk, otherwise ignore them unless the live worktree belongs to a ticket you are about to integrate, where they are actionable and outweigh an executor's `verify passed` claim. Keep error-severity diagnostics in your own files actionable.";

interface CheckoutLocation {
  checkoutRoot: string;
  projectRoot: string;
}

function gitDirectory(entry: string): string | null {
  try {
    if (fs.statSync(entry).isDirectory()) return entry;
    const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(entry, 'utf8'))?.[1];
    return gitDir ? path.resolve(path.dirname(entry), gitDir.trim()) : null;
  } catch (_) {
    return null;
  }
}

function checkoutLocation(start: string): CheckoutLocation | null {
  let current = path.resolve(start);
  while (true) {
    const gitDir = gitDirectory(path.join(current, '.git'));
    if (gitDir) {
      if (path.basename(gitDir) === '.git') return { checkoutRoot: current, projectRoot: current };
      const commonGitDir = path.resolve(gitDir, '..', '..');
      if (path.basename(commonGitDir) === '.git') return { checkoutRoot: current, projectRoot: path.dirname(commonGitDir) };
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isOwnWorktree(checkoutRoot: string, worktreesRoot: string, name: string): boolean {
  return path.resolve(path.dirname(checkoutRoot)) === path.resolve(worktreesRoot) && path.basename(checkoutRoot) === name;
}

export function diagnosticWorktreeWarning(input: HookInput): string {
  const start = stringField(input, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const location = checkoutLocation(start);
  if (!location) return '';

  const worktreesRoot = path.join(location.projectRoot, '.claude', 'worktrees');
  try {
    return fs.readdirSync(worktreesRoot, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && entry.name.startsWith('agent-') && !isOwnWorktree(location.checkoutRoot, worktreesRoot, entry.name)
    ) ? WARNING : '';
  } catch (_) {
    return '';
  }
}
