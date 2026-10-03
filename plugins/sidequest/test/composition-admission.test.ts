import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { proveCompositionRange, type CompositionRangeInput, type CompositionSourceRange } from '../src/lib/store/composition-range';

let repository: string;
let originalBase: string;
let candidate: string;
let input: CompositionRangeInput;
let sourceARange: CompositionSourceRange;
let sourceBRange: CompositionSourceRange;
let compositionMerge: string;

function git(argumentsList: readonly string[]): string {
  return execFileSync('git', [...argumentsList], {
    cwd: repository, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(relative: string, contents: string): void {
  const target = path.join(repository, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(message: string): string {
  git(['add', '.']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function rootOwnChange(): string {
  write('src/first.test.ts', 'export const first = 2;\n');
  write('src/second.test.ts', 'export const second = 2;\n');
  write('.release/unreleased/SQ-3.md', 'Root composition fragment\n');
  return commit('Root changes two pre-existing tests');
}

before(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-composition-range-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Composition Fixture']);
  git(['config', 'user.email', 'composition@example.invalid']);
  write('src/first.test.ts', 'export const first = 1;\n');
  write('src/second.test.ts', 'export const second = 1;\n');
  originalBase = commit('Original base');
  git(['checkout', '-b', 'source-a']);
  write('src/a.ts', 'export const sourceA = true;\n');
  const sourceA = commit('Source A');
  git(['checkout', '-b', 'source-b', originalBase]);
  write('src/b.ts', 'export const sourceB = true;\n');
  const sourceB = commit('Source B');
  git(['checkout', '-b', 'root', sourceA]);
  git(['merge', '--no-ff', 'source-b', '-m', 'Compose complete source ranges']);
  compositionMerge = git(['rev-parse', 'HEAD']);
  candidate = rootOwnChange();
  sourceARange = { ref: 'SQ-1', base: originalBase, commit: sourceA, commits: [sourceA], admittedScope: ['src/a.ts'] };
  sourceBRange = { ref: 'SQ-2', base: originalBase, commit: sourceB, commits: [sourceB], admittedScope: ['src/b.ts'] };
  input = {
    base: originalBase, candidate, ownCommits: [compositionMerge, candidate],
    ownPaths: ['.release/unreleased/SQ-3.md', 'src/first.test.ts', 'src/second.test.ts'],
    rootScope: ['src', '.release/unreleased/SQ-3.md'],
    sources: [sourceARange, sourceBRange],
  };
});

after(() => fs.rmSync(repository, { recursive: true, force: true }));

function expectRefusal(request: CompositionRangeInput, reason: string): void {
  const result = proveCompositionRange(repository, request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason, result.message);
}

test('composition admission: range proof preserves the full original BASE..C and both existing own tests', () => {
  const proof = proveCompositionRange(repository, input);
  assert.equal(proof.ok, true);
  assert.deepEqual([...proof.commits].sort(), git(['rev-list', `${originalBase}..${candidate}`]).split(/\r?\n/).sort());
  assert.deepEqual(proof.ownPaths, input.ownPaths);
  assert.equal(proof.commits.length, 4);
  assert.notEqual(input.base, input.candidate);
});

test('composition admission: hidden commit assertion refuses an unaccounted range member', () => {
  expectRefusal({ ...input, ownCommits: [candidate] }, 'hidden_commit');
});

test('composition admission: full-range assertion refuses candidate as the submission floor', () => {
  expectRefusal({ ...input, base: candidate }, 'empty_range');
});

test('composition admission: a commit may belong to only one accounted range', () => {
  expectRefusal({ ...input, ownCommits: [...input.ownCommits, sourceARange.commit] }, 'duplicate_commit');
});

test('composition admission: source ranges cannot omit their own immutable commits', () => {
  const source = { ...sourceARange, commits: [] };
  expectRefusal({ ...input, sources: [source, sourceBRange] }, 'stale_source');
});

test('composition admission: empty source ranges provide no ownership', () => {
  const source = { ...sourceARange, base: sourceARange.commit, commits: [] };
  expectRefusal({ ...input, sources: [source, sourceBRange] }, 'source_range_missing');
});

test('composition admission: ownPaths cannot conceal a changed existing file', () => {
  expectRefusal({ ...input, ownPaths: ['.release/unreleased/SQ-3.md', 'src/first.test.ts'] }, 'own_delta_mismatch');
});

test('composition admission: own changes must remain in the original root scope', () => {
  expectRefusal({ ...input, rootScope: ['src/first.test.ts', '.release/unreleased/SQ-3.md'] }, 'own_delta_out_of_scope');
});

test('composition admission: absolute and parent paths cannot expand original scope', () => {
  expectRefusal({ ...input, rootScope: ['../foreign'] }, 'own_delta_out_of_scope');
});

test('composition admission: the base must be an exact reachable immutable commit', () => {
  expectRefusal({ ...input, base: 'HEAD' }, 'composition_git_error');
});

test('composition admission: unilateral own merge edits cannot hide behind a clean combined diff', () => {
  git(['checkout', '--detach', compositionMerge]);
  write('foreign/hidden.ts', 'export const hidden = true;\n');
  git(['add', '.']);
  const tree = git(['write-tree']);
  const evilMerge = git(['commit-tree', tree, '-p', sourceARange.commit, '-p', sourceBRange.commit, '-m', 'Unilateral merge edit']);
  expectRefusal({ ...input, candidate: evilMerge, ownCommits: [evilMerge], ownPaths: [] }, 'own_merge_unsupported');
});

test('composition admission: rename ownership includes the deleted and added paths', () => {
  git(['checkout', '--detach', candidate]);
  git(['mv', 'src/first.test.ts', 'src/renamed.test.ts']);
  const renamed = commit('Rename first test');
  expectRefusal({ ...input, candidate: renamed, ownCommits: [...input.ownCommits, renamed] }, 'own_delta_mismatch');
});
