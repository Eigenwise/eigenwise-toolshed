import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalPath } from './kernel/worktree.js';

export function normalizeWorktreeDirectory(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('worktreeDirectory must be a relative directory or null.');
  const directory = value.trim().replace(/\\/g, '/');
  const segments = directory.split('/');
  if (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)
    || /[\x00-\x1f\x7f]/.test(directory)
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new Error('worktreeDirectory must stay below the repository without traversal or Git metadata paths.');
  }
  return directory;
}

export function configuredWorktreeRoot(repository: string, value: unknown): string | null {
  const directory = normalizeWorktreeDirectory(value);
  if (directory == null) return null;
  const root = canonicalPath(repository);
  let target = root;
  for (const segment of directory.split('/')) {
    target = path.join(target, segment);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`worktreeDirectory contains a symlink or reparse point: ${target}`);
      if (!stat.isDirectory()) throw new Error(`worktreeDirectory is not a directory: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error('worktreeDirectory must already exist; create the ignored directory before configuring it.');
    }
  }
  const tracked = execFileSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', directory], {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
  });
  if (tracked) throw new Error('worktreeDirectory contains tracked content; choose an ignored, untracked directory.');
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', directory], {
      cwd: root, windowsHide: true, stdio: 'pipe',
    });
  } catch (_) {
    throw new Error('worktreeDirectory must be Git-ignored before configuration or provisioning; Sidequest will not edit ignore rules.');
  }
  return target;
}
