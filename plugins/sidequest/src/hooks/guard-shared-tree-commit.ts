#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const GIT_COMMIT = /(?:^|[;&|\n]\s*|\$\(\s*)(?:&\s*)?git\s+(?:(?:-C|-c|--config-env)\s+(?:"[^"]+"|'[^']+'|\S+)\s+)*commit\b/gi;

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function quotedAt(command: string, index: number): boolean {
  let quote = '';
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === '\\') cursor += 1;
    else if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
  }
  return Boolean(quote);
}

function targetRepo(command: string, cwd: string, index: number): string {
  const before = command.slice(0, index);
  const dashCs = Array.from(before.matchAll(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const dashC = dashCs.at(-1);
  if (dashC?.[1]) return path.resolve(cwd, unquote(dashC[1]));
  const cds = Array.from(before.matchAll(/(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/gi));
  const cd = cds.at(-1);
  return cd?.[1] ? path.resolve(cwd, unquote(cd[1])) : path.resolve(cwd);
}

function repoRoot(repo: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function sharedCheckout(repo: string): boolean {
  try {
    return fs.statSync(path.join(repo, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function activeClaim(input: Record<string, unknown>): { ref: string; projectPath: string | null } | null {
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executor) return null;
  const store = require(runtimeModule('store')) as {
    activeSharedTreeClaim: (identity: unknown) => { ref: string; projectPath: string | null } | null;
  };
  return store.activeSharedTreeClaim({ agentId, executor });
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return;
  const command = String(toolInput.command || '');
  const cwd = stringField(input, 'cwd') || process.cwd();
  for (const match of command.matchAll(GIT_COMMIT)) {
    if (quotedAt(command, match.index || 0)) continue;
    const repo = repoRoot(targetRepo(command, cwd, match.index || 0));
    if (!repo || !sharedCheckout(repo)) continue;
    const claim = activeClaim(input);
    if (!claim || !claim.projectPath || !samePath(claim.projectPath, repo)) continue;
    writeDeny('PreToolUse', [
      `sidequest: refusing raw git commit for ${claim.ref} in the shared checkout.`,
      'Use mcp__plugin_sidequest_board__commit so Sidequest stages and commits only the approved ticket scope.',
      'If the path needs approval first, request scope before committing.',
    ].join('\n'));
    return;
  }
}

try {
  main();
} catch {
}
