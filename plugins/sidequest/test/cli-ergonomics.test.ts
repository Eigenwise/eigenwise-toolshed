import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'sidequest.js');

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(args: string[], env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isolatedEnv(): Record<string, string> {
  return {
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PROJECT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-ergonomics-project-')),
    SIDEQUEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-ergonomics-home-')),
    SIDEQUEST_DISCOVERY_DIRS: fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-ergonomics-catalog-')),
  };
}

test('CLI prints the installed plugin version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
  const result = run(['--version'], isolatedEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.version);
});

test('CLI command help stays focused on the requested command', () => {
  const cases = [
    ['add', '--dry-run'],
    ['profile', '--retired'],
    ['category', '--route-model'],
    ['projects', '--archived'],
    ['board-config', '--always-in-scope'],
    ['groom-close', '--delivery-commit'],
  ] as const;
  const env = isolatedEnv();
  for (const [command, flag] of cases) {
    const result = run([command, '--help'], env);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`sidequest ${command}`));
    assert.match(result.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stdout, /sidequest merge/);
  }
});

test('CLI records readonly false on add and update', () => {
  const env = isolatedEnv();
  const added = run(['add', '--title', 'mutable spike', '--unclassified', '--readonly', 'false', '--json'], env);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).ticket.readonlyOverride, false);

  const updated = run(['update', 'SQ-1', '--readonly', 'false', '--json'], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).ticket.readonlyOverride, false);
});

test('add --dry-run validates and previews without writing a board', () => {
  const cleanEnv = isolatedEnv();
  const missingTitle = run(['add', '--unclassified', '--dry-run'], cleanEnv);
  assert.equal(missingTitle.status, 1);

  const preview = run(['add', '--title', 'preview ticket', '--unclassified', '--dry-run'], cleanEnv);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Dry run: would create "preview ticket"/);
  assert.equal(fs.existsSync(path.join(cleanEnv.SIDEQUEST_HOME!, 'sidequest.db')), false);

  const env = isolatedEnv();
  const first = run(['add', '--title', 'first ticket', '--unclassified'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /SQ-1/);

  const repeatedPreview = run(['add', '--title', 'preview ticket', '--unclassified', '--dry-run'], env);
  assert.equal(repeatedPreview.status, 0, repeatedPreview.stderr);
  assert.doesNotMatch(repeatedPreview.stdout, /SQ-2/);

  const second = run(['add', '--title', 'second ticket', '--unclassified'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /SQ-2/);
});

test('CLI add and update combine repeated and comma-separated scope flags', () => {
  const env = isolatedEnv();
  const added = run([
    'add', '--title', 'combined scope', '--category', 'general',
    '--file', 'plugins/a.ts', '--files', 'plugins/b.ts,plugins/c.ts', '--json',
  ], env);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout).ticket.files, ['plugins/a.ts', 'plugins/b.ts', 'plugins/c.ts']);

  const updated = run([
    'update', 'SQ-1', '--files', 'plugins/d.ts', '--files', 'plugins/e.ts,plugins/f.ts', '--json',
  ], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout).ticket.files, ['plugins/d.ts', 'plugins/e.ts', 'plugins/f.ts']);
});

test('CLI reads add and update descriptions from --body-file', () => {
  const env = isolatedEnv();
  const bodyPath = path.join(env.CLAUDE_PROJECT_DIR!, 'ticket-body.md');
  fs.writeFileSync(bodyPath, '# Filed from a body file\n\nThe complete description.\n');

  const added = run(['add', '--title', 'body file ticket', '--unclassified', '--body-file', bodyPath, '--json'], env);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).ticket.description, '# Filed from a body file\n\nThe complete description.');

  fs.writeFileSync(bodyPath, 'Replacement description.\n');
  const updated = run(['update', 'SQ-1', '--body-file', bodyPath, '--json'], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).ticket.description, 'Replacement description.');
});

test('CLI refuses unknown and misapplied flags', () => {
  const env = isolatedEnv();
  const unknown = run(['add', '--title', 'unknown flag', '--unclassified', '--mistyped', 'value'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /add: unknown or unsupported flag --mistyped/);

  const misapplied = run(['list', '--body-file', 'description.md'], env);
  assert.equal(misapplied.status, 1);
  assert.match(misapplied.stderr, /list: unknown or unsupported flag --body-file/);
});
