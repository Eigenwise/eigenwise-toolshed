'use strict';
/**
 * Tests for --project resolution (SQ-86).
 *
 * Before the fix, `resolveProject()` in bin/sidequest.js checked whether the
 * --project value was an exact registered SLUG (a folder name like
 * "eigenwise-toolshed-f61e9c29"), and if not, silently treated it as a
 * filesystem PATH and auto-registered a brand-new board at
 * path.resolve(cwd, arg) — so a plain display NAME (what every caller
 * actually passes) fell straight through into minting a phantom empty board.
 * Running the same name from two different working directories (or two real
 * project folders sharing a basename) produced two boards with the same
 * display name and no way to tell them apart.
 *
 * The fix (store.findProject) resolves --project ONLY against already
 * registered boards — exact slug, case-insensitive display name, or a path
 * that matches a registered project's path — and reports back (never
 * creates) on an unknown or ambiguous reference. These tests cover both the
 * store-level resolver directly and the CLI wiring end to end.
 *
 * Run: node --test plugins/sidequest/test/project-resolution.test.js
 * (the directory form of `node --test` is broken on this Node v22/Windows setup)
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Point the store at a throwaway home so this suite never touches the real
// ~/.claude/sidequest data (same pattern as ladder.test.js).
const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-project-resolution-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
// A directory that need not exist on disk — store never validates that a
// registered project's path is real, only that it resolves to a string.
const FAKE_ROOT = path.join(os.tmpdir(), 'sq-project-resolution-fixtures');

function projectSlugsOnDisk() {
  try {
    return fs.readdirSync(path.join(SIDEQUEST_HOME, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (_) {
    return [];
  }
}

// Run the actual CLI as a subprocess against the same throwaway home, so
// these tests exercise the real bin/sidequest.js wiring, not just the store
// function it calls into.
function runCli(args, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, {
    SIDEQUEST_HOME,
    CLAUDE_PROJECT_DIR: opts.cwd || path.join(FAKE_ROOT, '__unused_default__'),
  });
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function cliJson(args, opts) {
  const res = runCli(args.concat(['--json']), opts);
  assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\nstderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/* ------------------------------------------------------------------ *
 *  store.findProject — direct unit tests on the resolver itself
 * ------------------------------------------------------------------ */

test('findProject: unknown reference never creates anything', () => {
  const before = projectSlugsOnDisk();
  const res = store.findProject('definitely-not-a-registered-project');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
  assert.ok(Array.isArray(res.known));
  const after = projectSlugsOnDisk();
  assert.deepStrictEqual(after, before, 'an unknown --project must never register a board');
});

test('findProject: exact name, case-insensitive name, and path all resolve to the same registered board', () => {
  const absPath = path.join(FAKE_ROOT, 'Alpha-Project');
  const { slug } = store.ensureProject(absPath, 'Alpha Project');

  const byExactName = store.findProject('Alpha Project');
  assert.strictEqual(byExactName.ok, true);
  assert.strictEqual(byExactName.slug, slug);

  const byCaseInsensitiveName = store.findProject('aLpHa PROJECT');
  assert.strictEqual(byCaseInsensitiveName.ok, true);
  assert.strictEqual(byCaseInsensitiveName.slug, slug);

  const byPath = store.findProject(absPath);
  assert.strictEqual(byPath.ok, true);
  assert.strictEqual(byPath.slug, slug);

  const bySlug = store.findProject(slug);
  assert.strictEqual(bySlug.ok, true);
  assert.strictEqual(bySlug.slug, slug);
});

test('findProject: path resolution is case-insensitive on Windows', { skip: process.platform !== 'win32' }, () => {
  const absPath = path.join(FAKE_ROOT, 'CaseFold-Project');
  const { slug } = store.ensureProject(absPath, 'CaseFold Project');
  const res = store.findProject(absPath.toUpperCase());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.slug, slug);
});

test('findProject: a name shared by two registered boards is ambiguous and demands the path form', () => {
  const pathA = path.join(FAKE_ROOT, 'dup-a');
  const pathB = path.join(FAKE_ROOT, 'dup-b');
  const before = projectSlugsOnDisk();
  const a = store.ensureProject(pathA, 'DupName');
  const b = store.ensureProject(pathB, 'DupName');

  const res = store.findProject('DupName');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'ambiguous');
  assert.strictEqual(res.matches.length, 2);
  const slugs = res.matches.map((m) => m.slug).sort();
  assert.deepStrictEqual(slugs, [a.slug, b.slug].sort());

  // Case-insensitivity applies to the ambiguity check too.
  const resLower = store.findProject('dupname');
  assert.strictEqual(resLower.reason, 'ambiguous');

  // The path form still disambiguates cleanly.
  const byPathA = store.findProject(pathA);
  assert.strictEqual(byPathA.ok, true);
  assert.strictEqual(byPathA.slug, a.slug);
  const byPathB = store.findProject(pathB);
  assert.strictEqual(byPathB.ok, true);
  assert.strictEqual(byPathB.slug, b.slug);

  // Resolving the ambiguous name must not have registered a third board.
  const after = projectSlugsOnDisk();
  assert.deepStrictEqual(after, [...before, a.slug, b.slug].sort());
});

/* ------------------------------------------------------------------ *
 *  CLI wiring — bin/sidequest.js resolveProject() end to end
 * ------------------------------------------------------------------ */

test('CLI: --project on list/claim never creates a namespace for an unknown name', () => {
  const before = projectSlugsOnDisk();

  const listRes = runCli(['list', '--project', 'no-such-board-xyz']);
  assert.notStrictEqual(listRes.status, 0, 'list with an unknown --project must fail');
  assert.match(listRes.stderr, /does not match any registered board/i);

  const claimRes = runCli(['claim', 'SQ-1', '--by', 'tester', '--project', 'no-such-board-xyz']);
  assert.notStrictEqual(claimRes.status, 0, 'claim with an unknown --project must fail');
  assert.match(claimRes.stderr, /does not match any registered board/i);

  const after = projectSlugsOnDisk();
  assert.deepStrictEqual(after, before, 'an unknown --project must never create a phantom board directory');
});

test('CLI: unknown-name error lists the known project names', () => {
  const projAbs = path.join(FAKE_ROOT, 'known-lister');
  cliJson(['add', '-t', 'seed ticket', '--complexity', '1', '--why', 'seed a real board so the error has something to list'], { cwd: projAbs });

  const res = runCli(['list', '--project', 'nope-not-registered']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /known-lister/);
});

test('CLI: name resolves to the right board (with real tickets), case-insensitively, through list/claim/release', () => {
  const projAbs = path.join(FAKE_ROOT, 'RoundTrip-Project');
  const added = cliJson(
    ['add', '-t', 'round trip ticket', '--complexity', '2', '--why', 'ticket used to prove --project name resolution round-trips cleanly'],
    { cwd: projAbs }
  );
  const ref = added.ticket.ref;
  const realSlug = added.project;

  // list --project by exact display name.
  const listByName = cliJson(['list', '--project', 'RoundTrip-Project']);
  assert.strictEqual(listByName.project, realSlug);
  assert.ok(listByName.tickets.some((t) => t.ref === ref), 'the real ticket must be visible via name-resolved --project');

  // list --project by a different case.
  const listByCase = cliJson(['list', '--project', 'roundtrip-project']);
  assert.strictEqual(listByCase.project, realSlug);

  // claim/release round-trip through the name form.
  const claim = cliJson(['claim', ref, '--by', 'sq86-test-worker', '--direct', '--project', 'ROUNDTRIP-PROJECT']);
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.project, realSlug);
  assert.strictEqual(claim.ticket.status, 'doing');

  const release = cliJson(['release', ref, '--by', 'sq86-test-worker', '--project', 'RoundTrip-Project', '--status', 'todo']);
  assert.strictEqual(release.ok, true);
  assert.strictEqual(release.ticket.status, 'todo');
  assert.strictEqual(release.ticket.claim, null);
});

test('CLI: a duplicate display name errors demanding the path form, and the path form resolves cleanly', () => {
  const pathA = path.join(FAKE_ROOT, 'clidup-a');
  const pathB = path.join(FAKE_ROOT, 'clidup-b');
  cliJson(['add', '-t', 'ticket in clidup a', '--complexity', '1', '--why', 'seed board A of a same-name pair for the CLI ambiguity test'], { cwd: pathA });
  // Register board B under the SAME display name as A via --name, from a
  // different real path — a genuine duplicate identity, same as the BMR case.
  const addBRes = runCli(
    ['add', '-t', 'ticket in clidup b', '--complexity', '1', '--why', 'seed board B sharing a display name with A for the CLI ambiguity test', '--name', 'clidup-a', '--json'],
    { cwd: pathB }
  );
  assert.strictEqual(addBRes.status, 0, addBRes.stderr);

  const before = projectSlugsOnDisk();
  const ambiguous = runCli(['list', '--project', 'clidup-a']);
  assert.notStrictEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /matches 2 boards named/i);
  assert.match(ambiguous.stderr, /pass the path to disambiguate/i);
  const after = projectSlugsOnDisk();
  assert.deepStrictEqual(after, before, 'an ambiguous --project name must never create a third board');

  // The path form disambiguates unambiguously.
  const byPathA = cliJson(['list', '--project', pathA]);
  const byPathB = cliJson(['list', '--project', pathB]);
  assert.notStrictEqual(byPathA.project, byPathB.project);
});

/* ------------------------------------------------------------------ *
 *  SQ-102 — --project with an ABSOLUTE path to a real directory may
 *  create (or reuse) that board, so an agent outside project B can file
 *  into B by passing B's full path. Names / relative refs / non-existent
 *  paths still never create (that was the SQ-86 hole).
 * ------------------------------------------------------------------ */

// Unlike FAKE_ROOT (whose paths need not exist), the create path guards on a
// REAL directory, so these fixtures are actually made on disk.
const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-project-create-'));
function realDir(name) {
  const p = path.join(REAL_ROOT, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
// A cwd that is deliberately NOT the target, to prove filing goes to --project
// and not to the working directory's own board.
const ELSEWHERE = path.join(FAKE_ROOT, 'not-the-target-cwd');

test('CLI: --project with an absolute path to a real dir creates that board, files into it, and reuses on repeat (never duplicates)', () => {
  const target = realDir('cross-project-target');
  const before = projectSlugsOnDisk();

  const first = cliJson(
    ['add', '-t', 'filed from outside', '--complexity', '1', '--why', 'prove an absolute --project path creates the target board and files into it', '--project', target],
    { cwd: ELSEWHERE }
  );
  assert.ok(first.ok);
  const afterFirst = projectSlugsOnDisk();
  assert.strictEqual(afterFirst.length, before.length + 1, 'exactly one board should have been created');
  assert.ok(afterFirst.includes(first.project), 'the created board must be the one the ticket landed in');

  // A second file at the SAME absolute path must reuse the board, not mint a
  // duplicate — the whole point of keying on the normalized path.
  const second = cliJson(
    ['add', '-t', 'filed from outside again', '--complexity', '1', '--why', 'prove a repeat absolute --project path reuses the same board', '--project', target],
    { cwd: ELSEWHERE }
  );
  assert.strictEqual(second.project, first.project, 'a repeat absolute-path --project must resolve to the same board');
  assert.deepStrictEqual(projectSlugsOnDisk(), afterFirst, 'a repeat absolute-path --project must not create a second board');

  // Both tickets live on the target board, reachable by that same path.
  const list = cliJson(['list', '--project', target]);
  assert.strictEqual(list.project, first.project);
  assert.strictEqual(list.tickets.length, 2, 'both tickets should be on the absolute-path target board');
});

test('CLI: --project with a --name creates the board with that display name so later name resolution works', () => {
  const target = realDir('named-cross-project');
  cliJson(
    ['add', '-t', 'seed named board', '--complexity', '1', '--why', 'prove --name rides along when an absolute --project path creates a board', '--project', target, '--name', 'Named Cross Project'],
    { cwd: ELSEWHERE }
  );
  // Now the display name resolves like any registered board.
  const byName = cliJson(['list', '--project', 'Named Cross Project']);
  assert.ok(byName.tickets.some((t) => t.title === 'seed named board'));
});

test('CLI: --project with a non-existent absolute path fails loudly and creates nothing', () => {
  const before = projectSlugsOnDisk();
  const missing = path.join(REAL_ROOT, 'this-dir-does-not-exist');
  const res = runCli(
    ['add', '-t', 'should not land', '--complexity', '1', '--why', 'a typo path must fail, not mint junk', '--project', missing],
    { cwd: ELSEWHERE }
  );
  assert.notStrictEqual(res.status, 0, 'a non-existent absolute --project path must fail');
  assert.match(res.stderr, /does not match any registered board/i);
  assert.deepStrictEqual(projectSlugsOnDisk(), before, 'a non-existent absolute --project path must never create a board');
});

test('CLI: an unregistered NAME still never creates, even though absolute paths now can', () => {
  const before = projectSlugsOnDisk();
  const res = runCli(
    ['add', '-t', 'should not land', '--complexity', '1', '--why', 'a bare name is ambiguous and must stay registered-only', '--project', 'some-unregistered-name'],
    { cwd: ELSEWHERE }
  );
  assert.notStrictEqual(res.status, 0, 'an unregistered name must fail');
  assert.match(res.stderr, /does not match any registered board/i);
  assert.deepStrictEqual(projectSlugsOnDisk(), before, 'an unregistered name must never create a board');
});

test('CLI: plain list/ready with no --project still auto-registers the default (cwd) board, unaffected by the fix', () => {
  const projAbs = path.join(FAKE_ROOT, 'default-flow-project');
  const before = projectSlugsOnDisk();
  const added = cliJson(
    ['add', '-t', 'default flow ticket', '--complexity', '1', '--why', 'confirm the no-flag default resolution path still auto-registers a board'],
    { cwd: projAbs }
  );
  assert.ok(added.ok);
  const after = projectSlugsOnDisk();
  assert.strictEqual(after.length, before.length + 1, 'the no-flag default path is expected to register exactly one new board');

  const list = runCli(['list'], { cwd: projAbs });
  assert.strictEqual(list.status, 0);
  assert.match(list.stdout, /default-flow-project/);
});
