import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, enclosingCheckout } from './runtime-identity.js';

// ponytail: a lexical guard, not a sandbox. It catches the shell forms an agent reaches for when it
// edits files (redirects, file commands, in-place sed, mutating git). An interpreter such as `node -e`
// or a script can still write; the session permission mode, which read-only executors inherit because
// Claude Code ignores permissionMode in plugin agent files, stays the real authority (GH-282).
type ShellToken = { operator: string } | { word: string };
type ShellSegment = { words: string[]; redirects: string[] };
type WriteTargetReader = (words: string[]) => string[];

const SHELL_TOKEN_RE = /((?:\d|&)?>>?(?:&\d?)?|&&|\|\||[|;\n])|("(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>"']+)/g;
const SEGMENT_OPERATORS = new Set(['&&', '||', '|', ';', '\n']);
const NULL_SINKS = new Set(['/dev/null', 'nul', '$null']);
const MUTATING_GIT = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'push',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch',
]);

function operands(words: string[]): string[] {
  return words.slice(1).filter((word) => !word.startsWith('-'));
}

function gitWriteTargets(words: string[]): string[] {
  const flagIndex = words.indexOf('-C');
  const directory = flagIndex > 0 ? words[flagIndex + 1] : '.';
  const subcommand = operands(words).find((word) => word !== directory);
  return MUTATING_GIT.has(String(subcommand)) ? [directory || '.'] : [];
}

function inPlaceEditTargets(words: string[]): string[] {
  return words.some((word) => /^-[a-z]*i/i.test(word)) ? operands(words).slice(1) : [];
}

const WRITE_TARGET_READERS = new Map<string, WriteTargetReader>([
  ...['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'chmod', 'chown', 'unlink',
    'remove-item', 'set-content', 'add-content', 'out-file', 'new-item', 'move-item', 'rename-item', 'clear-content',
    'ri', 'ni', 'del', 'erase', 'rd', 'md', 'move', 'ren'].map((name): [string, WriteTargetReader] => [name, operands]),
  ...['cp', 'copy', 'copy-item', 'ln', 'install', 'rsync'].map((name): [string, WriteTargetReader] => [name, (words) => operands(words).slice(-1)]),
  ['sed', inPlaceEditTargets],
  ['perl', inPlaceEditTargets],
  ['git', gitWriteTargets],
]);

function commandWriteTargets(words: string[]): string[] {
  const name = path.basename(words[0] || '').toLowerCase().replace(/\.exe$/, '');
  const reader = WRITE_TARGET_READERS.get(name);
  return reader ? reader(words) : [];
}

function shellTokens(command: string): ShellToken[] {
  return [...command.matchAll(SHELL_TOKEN_RE)].map((match) => (
    match[1] ? { operator: match[1] } : { word: match[2]!.replace(/^(["'])([\s\S]*)\1$/, '$2') }
  ));
}

// A dup such as `2>&1` names a descriptor, not a file, so only a plain redirect captures the next word.
function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [{ words: [], redirects: [] }];
  let pendingRedirect = false;
  for (const token of shellTokens(command)) {
    const segment = segments[segments.length - 1]!;
    if ('word' in token) {
      (pendingRedirect ? segment.redirects : segment.words).push(token.word);
      pendingRedirect = false;
    } else if (SEGMENT_OPERATORS.has(token.operator)) {
      segments.push({ words: [], redirects: [] });
    } else {
      pendingRedirect = !token.operator.includes('&', 1);
    }
  }
  return segments;
}

function ignoredTarget(word: string): boolean {
  return !word || word.startsWith('$') || NULL_SINKS.has(word.toLowerCase());
}

// Git Bash spells C:\x as /c/x, which path.resolve on Windows would read as \c\x on the current drive.
function nativePath(word: string): string {
  if (word === '~' || word.startsWith('~/')) return path.join(os.homedir(), word.slice(1));
  return process.platform === 'win32' ? word.replace(/^\/([a-z])(\/|$)/i, '$1:/') : word;
}

// The checkout root comes back canonical (a Git Bash /c/x drive, an 8.3 short name such as RUNNER~1
// on a CI runner), so the cwd and every target are canonicalized the same way before comparing.
function resolvedTarget(base: string, word: string): string | null {
  return ignoredTarget(word) ? null : canonicalPath(path.resolve(base, nativePath(word)));
}

function mainCheckoutOf(linkedRoot: string): string | null {
  const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(linkedRoot, '.git'), 'utf8'));
  return pointer ? canonicalPath(path.resolve(linkedRoot, pointer[1]!.trim(), '..', '..', '..')) : null;
}

// A linked worktree's shared checkout is protected too: a read-only run must not reach past its own tree.
function checkoutRoots(cwd: string): string[] {
  const checkout = enclosingCheckout(cwd);
  if (!checkout) return [];
  const main = checkout.linked ? mainCheckoutOf(checkout.root) : null;
  return main ? [checkout.root, main] : [checkout.root];
}

function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function insideAny(roots: string[], target: string): boolean {
  return roots.some((root) => isWithin(root, target));
}

function nextBase(words: string[], base: string): string {
  return words[0] === 'cd' && words[1] ? resolvedTarget(base, words[1]) || base : base;
}

function segmentWriteTargets(segment: ShellSegment, base: string): string[] {
  return [...segment.redirects, ...commandWriteTargets(segment.words)]
    .map((word) => resolvedTarget(base, word))
    .filter((target): target is string => target !== null);
}

function firstCheckoutWrite(command: string, cwd: string): string | null {
  const roots = checkoutRoots(cwd);
  let base = canonicalPath(cwd);
  for (const segment of shellSegments(command)) {
    base = nextBase(segment.words, base);
    const blocked = segmentWriteTargets(segment, base).find((target) => insideAny(roots, target));
    if (blocked) return blocked;
  }
  return null;
}

export function readOnlyShellRefusal(command: string, cwd: string): string | null {
  const blocked = firstCheckoutWrite(command, cwd);
  return blocked
    ? `sidequest: read-only executor, refusing a shell write inside the repository checkout (${blocked}). Keep temporary files and evidence outside the checkout, in your scratchpad or the ticket's verification directory. If the ticket needs a repository change, comment the needed edit on the ticket and release it instead.`
    : null;
}
