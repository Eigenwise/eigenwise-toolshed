import fs from 'node:fs';
import { execFileSync } from './git-process';

export interface SyncCheckInput {
  commit: string;
  worktree?: string;
  head?: string;
  retained?: boolean;
}

export interface SyncCheckResult {
  ok: boolean;
  line: string;
}

interface SyncFacts {
  input: SyncCheckInput;
  cwd: string;
  head: string;
  base: string;
}

// The porcelain codes git reports for a path still in the middle of a merge or rebase.
const UNMERGED_CODES = new Set(['UU', 'AA', 'DU', 'UD', 'AU', 'UA', 'DD']);

// The briefing reads the check through its output line and exit code, never through a trailing `echo $?`, which
// an isolated worktree's Bash guard refuses as a compound command it cannot prove stays in the worktree (GH-422).
export const SYNC_CHECK_RESULT = 'It prints one line and exits 0 for `sync-check: ok (...)` or 1 for `sync-check: FAILED <reason> (...)`; run it on its own and read that line, because no `; echo $?` is needed.';

export function syncCheckCommand(quotedLauncher: string, commit: string, flags = ''): string {
  return '`' + ['node', quotedLauncher, 'sync-check', commit + flags].join(' ') + '`';
}

export function retainedSyncCheckStep(quotedLauncher: string, commit: string, retainedCommit: string): string {
  return [
    'run ' + syncCheckCommand(quotedLauncher, commit, ' --head ' + retainedCommit + ' --retained') + '.',
    'It requires HEAD to be ' + retainedCommit + ' and `git status --porcelain` to still list the retained changes with no unmerged entries, and only then tests base ancestry.',
    SYNC_CHECK_RESULT,
    'If it reports `FAILED head-mismatch`, `retained-changes-missing` or `unmerged`, stop and report that this checkout is not the retained candidate.',
  ].join(' ');
}

const short = (sha: string) => sha.slice(0, 7);
const failed = (reason: string, detail: string): SyncCheckResult => ({ ok: false, line: `sync-check: FAILED ${reason} (${detail})` });

// A value starting with a dash is refused before git sees it: `rev-parse --verify` would read it as a flag,
// and the executor typed this value, so it is not trusted to be a revision.
function resolveCommit(cwd: string, revision: string): string {
  if (!revision || revision.startsWith('-')) return '';
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

// A corrupt index makes `git status` exit non-zero; null lets the caller report it as a structured line
// instead of letting the throw escape as a raw command failure with empty stdout.
function porcelainCodes(cwd: string): string[] | null {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split('\n').filter(Boolean).map((entry) => entry.slice(0, 2));
  } catch (_) {
    return null;
  }
}

// `--is-ancestor` answers through its exit code, so "not an ancestor" (1) arrives as a throw that has to be
// told apart from a probe that could not run at all.
function ancestry(cwd: string, base: string, head: string): 'ancestor' | 'unrelated' | 'unknown' {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, stdio: 'ignore' });
    return 'ancestor';
  } catch (error) {
    return (error as { status?: number }).status === 1 ? 'unrelated' : 'unknown';
  }
}

function headProblem({ input, cwd, head }: SyncFacts): SyncCheckResult | null {
  if (!input.head) return null;
  const wanted = resolveCommit(cwd, input.head);
  return wanted === head ? null : failed('head-mismatch', `HEAD is ${short(head)}, expected ${wanted ? short(wanted) : input.head}`);
}

function retainedProblem({ input, cwd }: SyncFacts): SyncCheckResult | null {
  if (!input.retained) return null;
  const codes = porcelainCodes(cwd);
  if (!codes) return failed('unreadable', 'git status --porcelain could not run');
  if (!codes.length) return failed('retained-changes-missing', 'git status --porcelain lists no changes, so this is not the retained candidate');
  return codes.some((code) => UNMERGED_CODES.has(code)) ? failed('unmerged', 'git status --porcelain lists unmerged entries') : null;
}

function ancestryProblem({ cwd, head, base }: SyncFacts): SyncCheckResult | null {
  const relation = ancestry(cwd, base, head);
  if (relation === 'unknown') return failed('unreadable', 'git merge-base could not run');
  return relation === 'unrelated' ? failed('not-ancestor', `${short(base)} is not an ancestor of HEAD ${short(head)}`) : null;
}

// Ancestry runs last on purpose: a retained-candidate continuation treats "not an ancestor" as the signal to
// move the base, which is only safe once the candidate and its retained changes are proven present.
const CHECKS = [headProblem, retainedProblem, ancestryProblem];

function gatherFacts(input: SyncCheckInput): SyncFacts | SyncCheckResult {
  const cwd = input.worktree || process.cwd();
  if (!fs.existsSync(cwd)) return failed('no-worktree', `${cwd} does not exist`);
  const head = resolveCommit(cwd, 'HEAD');
  if (!head) return failed('not-a-worktree', `${cwd} has no resolvable HEAD`);
  const base = resolveCommit(cwd, input.commit);
  return base ? { input, cwd, head, base } : failed('unknown-revision', `${input.commit} is not a commit in ${cwd}`);
}

function okExtras(input: SyncCheckInput): string[] {
  const extras: string[] = [];
  if (input.head) extras.push('HEAD is the expected commit');
  if (input.retained) extras.push('retained changes present, none unmerged');
  return extras;
}

function okLine({ input, head, base }: SyncFacts): SyncCheckResult {
  const detail = [`${short(base)} is an ancestor of HEAD ${short(head)}`, ...okExtras(input)].join('; ');
  return { ok: true, line: `sync-check: ok (${detail})` };
}

export function syncCheck(input: SyncCheckInput): SyncCheckResult {
  const facts = gatherFacts(input);
  if ('line' in facts) return facts;
  for (const check of CHECKS) {
    const problem = check(facts);
    if (problem) return problem;
  }
  return okLine(facts);
}
