import { execFileSync } from 'node:child_process';
import { validatePaths, validateRelativeScopes } from '../commit-scope';

export type CompositionSourceRange = Readonly<{
  ref: string;
  base: string;
  commit: string;
  commits: readonly string[];
  admittedScope: readonly string[];
}>;

export type CompositionRangeInput = Readonly<{
  base: string;
  candidate: string;
  ownCommits: readonly string[];
  ownPaths: readonly string[];
  rootScope: readonly string[];
  sources: readonly CompositionSourceRange[];
}>;

export type CompositionRefusal = Readonly<{ ok: false; reason: string; message: string }>;
export type CompositionRangeProof = Readonly<{ ok: true; commits: readonly string[]; ownPaths: readonly string[] }>;

function refuse(reason: string, message: string): CompositionRefusal {
  return { ok: false, reason, message };
}

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', [...arguments_], {
    cwd: repository, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function exactCommit(repository: string, commit: string): string {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Composition requires full immutable commit identities.');
  const observed = git(repository, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  if (observed !== commit) throw new Error('Composition commit identity changed during resolution.');
  return observed;
}

function commitsInRange(repository: string, base: string, candidate: string): string[] {
  exactCommit(repository, base);
  exactCommit(repository, candidate);
  git(repository, ['merge-base', '--is-ancestor', base, candidate]);
  return git(repository, ['rev-list', '--reverse', `${base}..${candidate}`, '--']).trim().split(/\r?\n/).filter(Boolean);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function completeSourceRange(repository: string, source: CompositionSourceRange): CompositionRefusal | undefined {
  const observed = commitsInRange(repository, source.base, source.commit);
  if (!observed.length) return refuse('source_range_missing', `${source.ref} has no submitted range.`);
  if (!sameMembers(observed, source.commits)) return refuse('stale_source', `${source.ref} no longer matches its complete immutable submitted range.`);
}

function sourceRangeRefusal(repository: string, sources: readonly CompositionSourceRange[]): CompositionRefusal | undefined {
  for (const source of sources) {
    const failure = completeSourceRange(repository, source);
    if (failure) return failure;
  }
}

function accountingRefusal(commits: readonly string[], input: CompositionRangeInput): CompositionRefusal | undefined {
  const accounted = [...input.sources.flatMap(source => [...source.commits]), ...input.ownCommits];
  if (new Set(accounted).size !== accounted.length) return refuse('duplicate_commit', 'Each composition commit must be accounted exactly once.');
  if (!commits.length) return refuse('empty_range', 'Composition must preserve nonempty work beyond the original base.');
  if (!sameMembers(commits, accounted)) return refuse('hidden_commit', 'The full original BASE..candidate range must equal the complete pinned source ranges plus ownCommits.');
}

function cleanMergePaths(repository: string, commit: string, parents: readonly string[]): string[] {
  if (parents.length !== 2) throw new Error('Only a clean two-parent composition merge is supported.');
  const mergedTree = git(repository, ['merge-tree', '--write-tree', ...parents]).trim().split(/\r?\n/)[0];
  const candidateTree = git(repository, ['rev-parse', `${commit}^{tree}`]).trim();
  if (mergedTree !== candidateTree) throw new Error('A composition own merge contains changes beyond its clean parent merge.');
  return [];
}

function ownCommitPaths(repository: string, commit: string): string[] {
  const parents = git(repository, ['show', '-s', '--format=%P', commit]).trim().split(' ').filter(Boolean);
  if (parents.length > 1) return cleanMergePaths(repository, commit, parents);
  return git(repository, ['diff-tree', '--root', '--no-renames', '--no-commit-id', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
}

function ownDeltaPaths(repository: string, commits: readonly string[]): { ok: true; paths: readonly string[] } | CompositionRefusal {
  try {
    return { ok: true, paths: [...new Set(commits.flatMap(commit => ownCommitPaths(repository, commit)))].sort() };
  } catch (error) {
    return refuse('own_merge_unsupported', error instanceof Error ? error.message : String(error));
  }
}

function ownScopeRefusal(paths: readonly string[], input: CompositionRangeInput): CompositionRefusal | undefined {
  if (!sameMembers(paths, input.ownPaths)) return refuse('own_delta_mismatch', 'ownPaths must exactly name every actual own change, including both sides of a rename.');
  if (!validatePaths(input.rootScope, [...paths]).ok) return refuse('own_delta_out_of_scope', 'Composition own changes must remain within the original root scope.');
}

function proveOwnDelta(repository: string, commits: readonly string[], input: CompositionRangeInput): CompositionRangeProof | CompositionRefusal {
  const delta = ownDeltaPaths(repository, input.ownCommits);
  if (!delta.ok) return delta;
  const failure = ownScopeRefusal(delta.paths, input);
  if (failure) return failure;
  return { ok: true, commits, ownPaths: delta.paths };
}

function proveRange(repository: string, input: CompositionRangeInput): CompositionRangeProof | CompositionRefusal {
  const commits = commitsInRange(repository, input.base, input.candidate);
  const failure = sourceRangeRefusal(repository, input.sources) || accountingRefusal(commits, input);
  if (failure) return failure;
  return proveOwnDelta(repository, commits, input);
}

export function proveCompositionRange(repository: string, input: CompositionRangeInput): CompositionRangeProof | CompositionRefusal {
  const scopes = validateRelativeScopes([...input.rootScope, ...input.ownPaths]);
  if (!scopes.ok) return refuse('own_delta_out_of_scope', 'Composition paths and scope must be repository-relative.');
  try {
    return proveRange(repository, input);
  } catch (error) {
    return refuse('composition_git_error', error instanceof Error ? error.message : String(error));
  }
}
