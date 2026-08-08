#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(repository: string, args: string[]): boolean {
  try {
    git(repository, args);
    return true;
  } catch (_) {
    return false;
  }
}

function repositoryFor(cwd: string): string {
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function existingWorktreeMatches(repository: string, target: string): boolean {
  try {
    const checkout = path.resolve(git(target, ['rev-parse', '--show-toplevel']));
    const commonOutput = git(target, ['rev-parse', '--git-common-dir']);
    const common = path.resolve(target, commonOutput);
    return samePath(checkout, target) && samePath(common, path.join(repository, '.git'));
  } catch (_) {
    return false;
  }
}

function baseRef(repository: string): string {
  try {
    return git(repository, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  } catch (_) {
    return 'HEAD';
  }
}

function createWorktree(repository: string, name: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (existingWorktreeMatches(repository, target)) return;
    if (fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    else throw new Error(`worktree destination already exists and is not registered to this repository: ${target}`);
  }
  const branch = `worktree-${name}`;
  git(repository, ['check-ref-format', '--branch', branch]);
  if (gitSucceeds(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    git(repository, ['worktree', 'add', target, branch]);
    return;
  }
  git(repository, ['worktree', 'add', '-b', branch, target, baseRef(repository)]);
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'hook_event_name') !== 'WorktreeCreate') return;
  const name = stringField(input, 'name');
  const cwd = stringField(input, 'cwd') || process.cwd();
  if (!name) throw new Error('WorktreeCreate requires a worktree name.');
  const repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule('worktrees')) as {
    namedWorktreePath: (repo: string, worktreeName: string) => string;
  };
  const target = worktrees.namedWorktreePath(repository, name);
  createWorktree(repository, name, target);
  process.stdout.write(`${target}\n`);
}

try {
  main();
} catch (error: any) {
  process.stderr.write(`sidequest: could not create external worktree: ${error?.message || String(error)}\n`);
  process.exit(1);
}
