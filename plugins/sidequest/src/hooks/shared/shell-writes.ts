// The lexical half of the read-only shell guard. It imports nothing, so the guards hooks module can
// tell a read-only executor's plain read from a command that names a write target without a process.
type ShellToken = { operator: string } | { word: string };
export type ShellSegment = { words: string[]; redirects: string[] };
type WriteTargetReader = (words: string[]) => string[];

const SHELL_TOKEN_RE = /(@"\r?\n[\s\S]*?\r?\n"@|@'\r?\n[\s\S]*?\r?\n'@|"(?:[^"\\`]|[\\`][\s\S]|"")*"|'(?:[^']|'')*')|((?:\d|&)?>>?(?:&\d?)?|&&|\|\||[|;\n])|([^\s|;&<>"']+)/g;
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

const SED_SCRIPT_FLAGS = new Set(['-e', '--expression', '-f', '--file']);

// sed -i writes only its file operands: the script after -e/-f is data, and without -e the first
// operand is the script (GH-566).
function inPlaceEditTargets(words: string[]): string[] {
  if (!words.some((word) => /^-[a-z]*i/i.test(word))) return [];
  const fileOperands = words.slice(1).filter((word, index, rest) => word && !word.startsWith('-') && !SED_SCRIPT_FLAGS.has(rest[index - 1] ?? ''));
  return words.some((word) => SED_SCRIPT_FLAGS.has(word)) ? fileOperands : fileOperands.slice(1);
}

// A content cmdlet's other words (-Value text, -ItemType File, -Encoding utf8) are data, not paths:
// reading them as targets refused fixture writes to the evidence root (SQ-3202).
function contentCmdletTargets(words: string[]): string[] {
  const pathFlag = words.findIndex((word) => /^-(path|literalpath|filepath)$/i.test(word));
  if (pathFlag > 0) return words.slice(pathFlag + 1, pathFlag + 2);
  return words.slice(1).filter((word, index) => (
    !word.startsWith('-') && !/^-(value|encoding|itemtype|width|name)$/i.test(words[index]!)
  )).slice(0, 1);
}

const WRITE_TARGET_READERS = new Map<string, WriteTargetReader>([
  ...['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'chmod', 'chown', 'unlink',
    'remove-item', 'move-item', 'rename-item', 'clear-content',
    'ri', 'del', 'erase', 'rd', 'md', 'move', 'ren'].map((name): [string, WriteTargetReader] => [name, operands]),
  ...['set-content', 'add-content', 'out-file', 'new-item', 'ni'].map((name): [string, WriteTargetReader] => [name, contentCmdletTargets]),
  ...['cp', 'copy', 'copy-item', 'ln', 'install', 'rsync'].map((name): [string, WriteTargetReader] => [name, (words) => operands(words).slice(-1)]),
  ['sed', inPlaceEditTargets],
  ['perl', inPlaceEditTargets],
  ['git', gitWriteTargets],
]);

function commandName(words: string[]): string {
  return (words[0] || '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
}

export function isGitMutation(words: string[]): boolean {
  return commandName(words) === 'git' && gitWriteTargets(words).length > 0;
}

export function commandWriteTargets(words: string[]): string[] {
  const reader = WRITE_TARGET_READERS.get(commandName(words));
  return reader ? reader(words) : [];
}

function shellTokens(command: string): ShellToken[] {
  return [...command.matchAll(SHELL_TOKEN_RE)].map((match) => (
    match[2] ? { operator: match[2] } : { word: (match[1] || match[3]!).replace(/^(["'])([\s\S]*)\1$/, '$2') }
  ));
}

// A dup such as `2>&1` names a descriptor, not a file, so only a plain redirect captures the next word.
export function shellSegments(command: string): ShellSegment[] {
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

export function ignoredTarget(word: string): boolean {
  return !word || word.startsWith('$') || NULL_SINKS.has(word.toLowerCase());
}

function segmentNamesWrite(segment: ShellSegment): boolean {
  return isGitMutation(segment.words)
    || [...segment.redirects, ...commandWriteTargets(segment.words)].some((word) => !ignoredTarget(word));
}

// True when readOnlyShellRefusal could refuse the command, whatever the cwd.
export function namesShellWrite(command: string): boolean {
  return shellSegments(command).some(segmentNamesWrite);
}
