#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';

const GIT = String.raw`git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?`;
const DESTRUCTIVE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: new RegExp(`${GIT}reset\\s+[^\\n;|&]*--hard`, 'i'), label: 'git reset --hard' },
  { pattern: new RegExp(`${GIT}clean\\s+-[a-z]*f`, 'i'), label: 'git clean -f' },
  { pattern: new RegExp(`${GIT}(?:checkout|restore)\\s+(?:[^\\n;|&]*\\s)?(?:--\\s+)?(?:\\.|:/)(?:\\s|$|;|&|\\|)`, 'i'), label: 'a whole-tree checkout/restore' },
  { pattern: new RegExp(`${GIT}(?:checkout|switch)\\s+[^\\n;|&]*(?:--force|\\s-f)\\b`, 'i'), label: 'a forced checkout/switch' },
];

function commandText(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || '') : '';
}

function destructive(command: string): string | null {
  for (const { pattern, label } of DESTRUCTIVE) if (pattern.test(command)) return label;
  return null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

// Best effort: the repo a destructive command would actually hit is named by
// `git -C`, by a leading `cd`, or is just the session cwd.
function targetRepo(command: string, cwd: string): string {
  const dashC = /git\s+-C\s+("[^"]+"|'[^']+'|\S+)/i.exec(command);
  if (dashC?.[1]) return path.resolve(cwd || '.', unquote(dashC[1]));
  const cd = /(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/i.exec(command);
  if (cd?.[1]) return path.resolve(cwd || '.', unquote(cd[1]));
  return path.resolve(cwd || '.');
}

function sharedCheckout(repo: string): boolean {
  try {
    return fs.statSync(path.join(repo, '.git')).isDirectory();
  } catch (_) {
    return false;
  }
}

function dirtyPaths(repo: string): string[] {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// The only thing that saved nine files of finished executor work on 2026-07-24
// was someone reading `git status` by chance before the publish flow's reset.
// A stash is recoverable; the reset is not, so the refusal offers the stash.
function refusal(label: string, repo: string, dirty: string[]): string {
  const shown = dirty.slice(0, 10).map((line) => `  ${line}`);
  if (dirty.length > shown.length) shown.push(`  … +${dirty.length - shown.length} more`);
  return [
    `sidequest: refusing ${label} — the shared checkout has ${dirty.length} uncommitted change(s) that this operation would destroy.`,
    `  repo: ${repo}`,
    ...shown,
    'Some of this may be a live executor\'s finished work that lost its worktree; the shared tree is not yours alone.',
    'Next step: decide per path. Commit what belongs to a ticket (`sidequest commit`, or a scoped `git commit`), then `git stash push -u -- <paths>` for anything you truly want out of the way. A stash is recoverable, this operation is not. Re-run once `git status --porcelain` is empty.',
  ].join('\n');
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const command = commandText(input);
  const label = destructive(command);
  if (!label) return;
  const repo = targetRepo(command, stringField(input, 'cwd'));
  if (!sharedCheckout(repo)) return;
  const dirty = dirtyPaths(repo);
  if (!dirty.length) return;
  writeDeny('PreToolUse', refusal(label, repo, dirty));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
