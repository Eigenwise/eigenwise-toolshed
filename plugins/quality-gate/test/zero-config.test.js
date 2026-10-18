import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { provisionParser } from '../lib/provision.mjs';

const entry = fileURLToPath(new URL('../bin/quality-gate.js', import.meta.url));

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-zero-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'subject.ts'), 'export function subject(value: number) { return value; }\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return root;
}

function cli(root, ...argumentsList) {
  return spawnSync(process.execPath, [entry, ...argumentsList, '--project', root], { encoding: 'utf8', timeout: 60000 });
}

test('zero-config crap checks tracked complexity and prints the missing coverage notice', async (context) => {
  const root = await fixture(context);
  await fs.writeFile(path.join(root, 'untracked.ts'), 'this is not valid TypeScript');
  const passed = cli(root, 'crap', '--base', 'HEAD', '--json');
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /coverage: not set up \(complexity only\); add an LCOV producer or --lcov to prove CRAP/);
  assert.deepEqual(Object.keys(JSON.parse(passed.stdout).files), ['subject.ts']);
  await fs.writeFile(path.join(root, 'subject.ts'), 'export function subject(a,b,c,d,e) { if(a) return 1; if(b) return 2; if(c) return 3; if(d) return 4; if(e) return 5; return 0; }\n');
  const failed = cli(root, 'crap', '--json');
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).failures[0].complexity, 6);
});

test('turn JSON reports one edited body with pinned keys and no coverage capture', async (context) => {
  const root = await fixture(context);
  await fs.writeFile(path.join(root, 'subject.ts'), 'export function subject(value: number) { return value ? 1 : 0; }\n');
  const result = cli(root, 'turn', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bodies: [{ file: 'subject.ts', name: 'subject', cc: 2, state: 'modified-raised', verdict: 'pass' }], signals: [], unverified: true, lcov: null });
  const later = cli(root, 'turn', '--json', '--since', '2999-01-01T00:00:00Z');
  assert.deepEqual(JSON.parse(later.stdout).bodies, []);
  const earlier = cli(root, 'turn', '--json', '--since', '2000-01-01T00:00:00Z');
  assert.equal(JSON.parse(earlier.stdout).bodies.length, 1);
});

test('turn includes untracked bodies and maps duplicate signal keys', async (context) => {
  const root = await fixture(context);
  await fs.writeFile(path.join(root, 'other.ts'), 'export function subject() { return 2; }\n');
  const result = cli(root, 'turn', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bodies[0].state, 'new');
  assert.deepEqual(Object.keys(report.signals[0]), ['kind', 'file', 'name', 'detail']);
  assert.equal(report.signals[0].kind, 'duplicate');
});

test('inventory fits the UTF-8 byte budget including the omission line', async (context) => {
  const root = await fixture(context);
  const full = cli(root, 'inventory', '--bytes', '2048');
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, 'subject subject.ts\n');
  const limited = cli(root, 'inventory', '--bytes', '13');
  assert.equal(limited.status, 0, limited.stderr);
  assert.equal(limited.stdout, '… 1 more\n');
  assert.ok(Buffer.byteLength(limited.stdout) <= 13);
  assert.equal(cli(root, 'inventory', '--bytes', '0').stdout, '');
  assert.equal(cli(root, 'inventory', '--bytes', '-1').status, 2);
});

test('provision installs once from an empty state and serializes concurrent callers', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-provision-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(fs.stat(path.join(root, 'node_modules')), { code: 'ENOENT' });
  let installed = false;
  let runs = 0;
  const notices = [];
  const options = { resolveCompiler: () => installed, runner: async () => { runs += 1; installed = true; }, notice: (text) => notices.push(text) };
  await Promise.all([provisionParser(root, options), provisionParser(root, options)]);
  await provisionParser(root, options);
  assert.equal(runs, 1);
  assert.deepEqual(notices, ['quality-gate: installing the TypeScript parser (one time)\n']);
  await assert.rejects(fs.stat(path.join(root, 'node_modules/.quality-gate-provision.lock')), { code: 'ENOENT' });
});

test('provision failures give a manual remedy and release the installation lock', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gate-offline-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { resolveCompiler: () => null, runner: async () => { throw new Error('offline'); }, notice: () => {} };
  await assert.rejects(provisionParser(root, options), /offline.*npm install --prefix/);
  await assert.rejects(fs.stat(path.join(root, 'node_modules/.quality-gate-provision.lock')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'node_modules/.quality-gate-provision.lock'), '');
  await assert.rejects(provisionParser(root, { ...options, timeout: 1 }), /lock timed out.*npm install --prefix/);
});

test('provision command succeeds when the plugin parser is already installed', async (context) => {
  const root = await fixture(context);
  const result = cli(root, 'provision');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
