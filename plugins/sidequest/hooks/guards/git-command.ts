import { resolveAbsolute, type Machine } from './text-guards.js';

// The one shell-command reader every git guard shares: where each git invocation sits, which directory it
// acts in, and which subcommand it runs. No Node, so the hooks module and its tests share it.

const WORD = String.raw`(?:"[^"]+"|'[^']+'|\S+)`;
const GIT = String.raw`git\s+(?:-C\s+${WORD}\s+)?`;
const DESTRUCTIVE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: new RegExp(`${GIT}reset\\s+[^\\n;|&]*--hard`, 'i'), label: 'git reset --hard' },
  { pattern: new RegExp(`${GIT}clean\\s+-[a-z]*f`, 'i'), label: 'git clean -f' },
  { pattern: new RegExp(`${GIT}(?:checkout|restore)\\s+(?:[^\\n;|&]*\\s)?(?:--\\s+)?(?:\\.|:/)(?:\\s|$|;|&|\\|)`, 'i'), label: 'a whole-tree checkout/restore' },
  { pattern: new RegExp(`${GIT}(?:checkout|switch)\\s+[^\\n;|&]*(?:--force|\\s-f)\\b`, 'i'), label: 'a forced checkout/switch' },
];
const INVOCATION = new RegExp(String.raw`(?:^\s*|[;&|\n]\s*|\$\(\s*)(?:&\s*)?git\s+((?:(?:-C|-c|--config-env)\s+${WORD}\s+)*)([a-z][a-z-]*)\b([^\n;|&]*)`, 'gi');
// Case-sensitive: `-c name=value` sets config, only `-C` names a directory.
const DASH_C = new RegExp(String.raw`(?:^|\s)-C\s+(${WORD})`, 'g');
const CD = new RegExp(String.raw`(?:^|[\n;&|])\s*cd\s+(${WORD})`, 'gi');

export type GitInvocation = { index: number; dashC: string | null; subcommand: string; args: string };
export type DestructiveMatch = { label: string; index: number; dashC: string | null };

export function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

export function shellTokens(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
}

const BALANCED_QUOTES = /^(?:[^"']|"[^"]*"|'[^']*')*$/;

// A backslash escapes the next character inside quotes or out, so escaped pairs drop before the quotes pair up.
export function quotedAt(command: string, index: number): boolean {
  return !BALANCED_QUOTES.test(command.slice(0, index).replace(/\\[\s\S]/g, ''));
}

function lastDashC(text: string): string | null {
  const found = [...text.matchAll(DASH_C)].at(-1)?.[1];
  return found ? unquote(found) : null;
}

export function gitInvocations(command: string): GitInvocation[] {
  return [...command.matchAll(INVOCATION)]
    .filter((match) => !quotedAt(command, match.index))
    .map((match) => ({ index: match.index, dashC: lastDashC(match[1] ?? ''), subcommand: (match[2] ?? '').toLowerCase(), args: match[3] ?? '' }));
}

export function destructiveMatch(command: string): DestructiveMatch | null {
  for (const { pattern, label } of DESTRUCTIVE) {
    const match = pattern.exec(command);
    if (match) return { label, index: match.index, dashC: lastDashC(match[0]) };
  }
  return null;
}

// Git Bash spells C:\x as /c/x; only Windows needs the drive put back.
function gitBashPath(value: string, machine: Machine): string {
  const drive = machine.windows ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  return drive ? `${drive[1]}:${value.slice(2)}` : value;
}

export function shellPath(cwd: string, value: string, machine: Machine): string {
  const target = gitBashPath(value, machine);
  const absolute = machine.windows ? /^(?:[A-Za-z]:)?[\\/]/.test(target) : target.startsWith('/');
  return resolveAbsolute(absolute ? target : `${gitBashPath(cwd, machine)}/${target}`, machine);
}

// Where a git invocation at `index` acts: its own -C, taken from the last `cd` before it, else from cwd.
export function invocationDirectory(command: string, index: number, dashC: string | null, cwd: string, machine: Machine): string {
  const cd = [...command.slice(0, index).matchAll(CD)].at(-1)?.[1];
  const base = shellPath(cwd, cd ? unquote(cd) : '.', machine);
  return dashC ? shellPath(base, dashC, machine) : base;
}

export function samePath(left: string, right: string, machine: Machine): boolean {
  const normalize = (value: string) => {
    const resolved = resolveAbsolute(gitBashPath(value, machine), machine);
    return machine.windows ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function tagAction(args: string): boolean {
  const tokens = shellTokens(args);
  if (tokens.some((token) => /^(?:-a|--annotate|-s|--sign|-u|--local-user|-d|--delete|-f|--force)$/.test(token))) return true;
  const lists = tokens.some((token) => /^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--column|--sort|--format)$/.test(token));
  return !lists && tokens.some((token) => !token.startsWith('-'));
}

export function isTagRef(value: string): boolean {
  return value.replace(/^\+/, '').startsWith('refs/tags/') || value === '--tags' || value === '--follow-tags';
}

export function branchName(value: string): string {
  return value.replace(/^\+/, '').replace(/^refs\/heads\//, '').replace(/^\/+/, '');
}

export function pushesEverything(tokens: readonly string[]): boolean {
  return tokens.some((token) => token === '--tags' || token === '--follow-tags' || token === '--all' || token === '--mirror');
}
