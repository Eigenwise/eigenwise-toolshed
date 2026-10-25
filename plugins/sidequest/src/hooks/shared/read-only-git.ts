const READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'describe', 'blame',
  'merge-base', 'grep', 'for-each-ref', 'show-ref', 'shortlog', 'ls-remote', 'name-rev',
  'count-objects', 'check-ignore', 'check-attr', 'diff-tree', 'diff-index',
]);
const GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
const GLOBAL_FLAGS = new Set(['--no-pager', '--paginate', '-P', '-p', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects']);
const BRANCH_READ_FLAGS = /^(?:--list|--show-current|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--no-color|--color(?:=.*)?|--format=.*|--sort=.*|--contains(?:=.*)?|--no-contains(?:=.*)?|--merged(?:=.*)?|--no-merged(?:=.*)?|--points-at(?:=.*)?)$/;

function branchReads(arguments_: string[]): boolean {
  const flags = arguments_.filter((argument) => argument.startsWith('-'));
  if (!flags.every((flag) => BRANCH_READ_FLAGS.test(flag))) return false;
  return arguments_.every((argument) => argument.startsWith('-')) || arguments_.includes('--list');
}

const CONFIG_READ_ARGUMENTS = /^(?:(?:--global|--local|--system|--worktree) )?(?:(?:--get|--get-all) [^ -][^ ]*|(?:--list|-l))$/;
const TAG_READ_FLAGS = /^(?:--list|-l|--contains(?:=.*)?|--points-at(?:=.*)?|--no-color|--color(?:=.*)?|--format=.*|--sort=.*|--ignore-case|-i|-n\d*)$/;

function tagReads(arguments_: string[]): boolean {
  const flags = arguments_.filter((argument) => argument.startsWith('-'));
  return flags.some((flag) => /^(?:--list|-l|--contains|--points-at)(?:=|$)/.test(flag))
    && flags.every((flag) => TAG_READ_FLAGS.test(flag));
}

function reflogReads(arguments_: string[]): boolean {
  return !arguments_.some((argument) => ['expire', 'delete', 'drop', 'write'].includes(argument));
}

const READ_ARGUMENTS = new Map<string, (arguments_: string[]) => boolean>([
  ['branch', branchReads],
  ['worktree', (arguments_) => arguments_[0] === 'list'],
  ['remote', (arguments_) => /^(?:-v$|(?:show|get-url)(?: |$))/.test(arguments_.join(' '))],
  ['config', (arguments_) => CONFIG_READ_ARGUMENTS.test(arguments_.join(' '))],
  ['tag', tagReads],
  ['stash', (arguments_) => ['list', 'show'].includes(arguments_[0] ?? '')],
  ['reflog', reflogReads],
]);

export function isReadOnlyGit(subcommand: string, arguments_: string[]): boolean {
  if (arguments_.some((argument) => /^--output(?:=|$)/.test(argument))) return false;
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
  return READ_ARGUMENTS.get(subcommand)?.(arguments_) ?? false;
}

function globalFlagWidth(word: string): number {
  if (GLOBAL_VALUE_FLAGS.has(word)) return 2;
  if (GLOBAL_FLAGS.has(word)) return 1;
  return /^(?:--(?:config-env|git-dir|work-tree|namespace|super-prefix)=|-C.|-c.)/.test(word) ? 1 : 0;
}

export function gitSubcommandIndex(words: string[]): number {
  let index = 1;
  while (words[index]?.startsWith('-')) {
    const width = globalFlagWidth(words[index]!);
    if (!width) return -1;
    index += width;
  }
  return index < words.length ? index : -1;
}

export function gitWordsReadOnly(words: string[]): boolean {
  const index = gitSubcommandIndex(words);
  return index > 0 && isReadOnlyGit(words[index]!, words.slice(index + 1));
}
