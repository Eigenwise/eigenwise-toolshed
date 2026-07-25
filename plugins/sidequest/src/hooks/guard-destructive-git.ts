#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';

const runtimeRequire = createRequire(__filename);
const store = runtimeRequire(['..', 'lib', 'store'].join('/'));
const publish = runtimeRequire(['..', 'lib', 'publish'].join('/'));
const GIT = String.raw`git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?`;
const DESTRUCTIVE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: new RegExp(`${GIT}reset\\s+[^\\n;|&]*--hard`, 'i'), label: 'git reset --hard' },
  { pattern: new RegExp(`${GIT}clean\\s+-[a-z]*f`, 'i'), label: 'git clean -f' },
  { pattern: new RegExp(`${GIT}(?:checkout|restore)\\s+(?:[^\\n;|&]*\\s)?(?:--\\s+)?(?:\\.|:/)(?:\\s|$|;|&|\\|)`, 'i'), label: 'a whole-tree checkout/restore' },
  { pattern: new RegExp(`${GIT}(?:checkout|switch)\\s+[^\\n;|&]*(?:--force|\\s-f)\\b`, 'i'), label: 'a forced checkout/switch' },
];
const GIT_ACTION = /(?:^|[;&|\n]\s*|\$\(\s*)(?:&\s*)?git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(tag|push)\b([^\n;|&]*)/gi;

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

function targetRepo(command: string, cwd: string): string {
  const dashCs = Array.from(command.matchAll(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const dashC = dashCs.at(-1);
  if (dashC?.[1]) return path.resolve(cwd || '.', unquote(dashC[1]));
  const cds = Array.from(command.matchAll(/(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/gi));
  const cd = cds.at(-1);
  if (cd?.[1]) return path.resolve(cwd || '.', unquote(cd[1]));
  return path.resolve(cwd || '.');
}

function quotedAt(command: string, index: number): boolean {
  let quote = '';
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === '\\') {
      cursor += 1;
    } else if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    }
  }
  return !!quote;
}

function actionRepo(command: string, cwd: string, index: number, options: string): string {
  const beforeAction = command.slice(0, index);
  const base = targetRepo(beforeAction, cwd);
  const paths = Array.from(options.matchAll(/(?:^|\s)-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const selected = paths.at(-1);
  return repoRoot(selected?.[1] ? path.resolve(base, unquote(selected[1])) : base);
}

function repoRoot(repo: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return repo;
  }
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

function shellTokens(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
}

function gitOutput(repo: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function configuredIntegrationBranch(repo: string): string {
  try {
    const project = store.findProject(repo);
    if (project.ok) return store.boardConfig(project.slug).integrationBranch;
  } catch {
    // An unavailable board must not make ordinary Git commands fail closed.
  }
  return 'main';
}

function defaultBranch(repo: string, remote: string): string {
  const ref = gitOutput(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  const branches = gitOutput(repo, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]).split(/\r?\n/)
    .map((branch) => branch.replace(`${remote}/`, ''))
    .filter((branch) => branch && branch !== 'HEAD');
  return ['main', 'master', 'trunk'].find((branch) => branches.includes(branch)) || branches[0] || 'main';
}

function currentBranch(repo: string): string {
  return gitOutput(repo, ['branch', '--show-current']);
}

function upstream(repo: string): { remote: string; branch: string } | null {
  const ref = gitOutput(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const slash = ref.indexOf('/');
  return slash > 0 ? { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) } : null;
}

function isRemote(repo: string, name: string): boolean {
  return !!gitOutput(repo, ['remote', 'get-url', name]);
}

function branchName(value: string): string {
  return value.replace(/^\+/, '').replace(/^refs\/heads\//, '').replace(/^\/+/, '');
}

function isTagRef(value: string): boolean {
  return value.replace(/^\+/, '').startsWith('refs/tags/') || value === '--tags' || value === '--follow-tags';
}

function tagAction(args: string): boolean {
  const tokens = shellTokens(args);
  if (!tokens.length) return false;
  if (tokens.some((token) => /^(?:-a|--annotate|-s|--sign|-u|--local-user|-d|--delete|-f|--force)$/.test(token))) return true;
  const lists = tokens.some((token) => /^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--column|--sort|--format)$/.test(token));
  return !lists && tokens.some((token) => !token.startsWith('-'));
}

function pushAction(args: string, repo: string, integrationBranch: string): boolean {
  const tokens = shellTokens(args);
  if (tokens.some((token) => token === '--tags' || token === '--follow-tags' || token === '--all' || token === '--mirror')) return true;
  const positional = tokens.filter((token) => !token.startsWith('-'));
  let remote = upstream(repo)?.remote || 'origin';
  if (positional.length && isRemote(repo, positional[0]!)) remote = positional.shift() || remote;
  const specs = positional;
  if (specs.some((spec) => isTagRef(spec) || spec.includes('*'))) return true;
  const defaultTarget = upstream(repo)?.branch || currentBranch(repo);
  const published = defaultBranch(repo, remote);
  return specs.length === 0
    ? defaultTarget === published && defaultTarget !== integrationBranch
    : specs.some((spec) => {
      const destination = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
      if (!destination || isTagRef(destination)) return true;
      const target = destination === 'HEAD' ? defaultTarget : branchName(destination);
      return target === published && target !== integrationBranch;
    });
}

function publicationAction(command: string, cwd: string): { label: string; repo: string } | null {
  const actions = Array.from(command.matchAll(GIT_ACTION));
  for (const match of actions) {
    if (quotedAt(command, match.index || 0)) continue;
    const optionPath = match[1] || '';
    const action = match[2] || '';
    const args = match[3] || '';
    const repo = actionRepo(command, cwd, match.index || 0, optionPath ? `-C ${optionPath}` : '');
    const integrationBranch = configuredIntegrationBranch(repo);
    if (action.toLowerCase() === 'tag' && tagAction(args)) return { label: 'manual git tag', repo };
    if (action.toLowerCase() === 'push' && pushAction(args, repo, integrationBranch)) {
      return { label: `a push to the published branch (${defaultBranch(repo, upstream(repo)?.remote || 'origin')})`, repo };
    }
  }
  return null;
}

function destructiveRefusal(label: string, repo: string, dirty: string[]): string {
  const shown = dirty.slice(0, 10).map((line) => `  ${line}`);
  if (dirty.length > shown.length) shown.push(`  … +${dirty.length - shown.length} more`);
  return [
    `sidequest: refusing ${label} — the shared checkout has ${dirty.length} uncommitted change(s) that this operation would destroy.`,
    `  repo: ${repo}`,
    ...shown,
    'Some of this may be a live executor\'s finished work that lost its worktree; the shared tree is not yours alone.',
    `Next step: preserve every dirty path in a named stash (for example, \`git stash push -u -m "sidequest recovery"\`), then run \`sidequest recover-shared --project "${repo}" --stash <stash@{n}> --yes\`. That exact recovery action verifies the stash before it runs \`git reset --hard && git clean -fd\`.`,
  ].join('\n');
}

function publicationRefusal(label: string, repo: string): string {
  return [
    `sidequest: refusing ${label} without the current session's publish lock.`,
    `  repo: ${repo}`,
    'Acquire it with `sidequest publish lock` before a deliberate release cut, then retry.',
    'This is a local early warning. Server-side GitHub rules remain the guarantee.',
  ].join('\n');
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const command = commandText(input);
  const repo = repoRoot(targetRepo(command, stringField(input, 'cwd')));
  const publication = publicationAction(command, stringField(input, 'cwd'));
  if (publication && !publish.publishLockOwnedBySession(publication.repo, stringField(input, 'session_id'))) {
    writeDeny('PreToolUse', publicationRefusal(publication.label, publication.repo));
    return;
  }
  const label = destructive(command);
  if (!label || !sharedCheckout(repo)) return;
  const dirty = dirtyPaths(repo);
  if (dirty.length) writeDeny('PreToolUse', destructiveRefusal(label, repo, dirty));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
