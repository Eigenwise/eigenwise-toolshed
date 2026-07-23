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

test('CLI add accepts both --files and --file for ticket scope', () => {
  const env = isolatedEnv();
  const plural = run(['add', '--title', 'plural scope', '--category', 'general', '--files', 'plugins/a.ts,plugins/b.ts', '--json'], env);
  assert.equal(plural.status, 0, plural.stderr);
  assert.deepEqual(JSON.parse(plural.stdout).ticket.files, ['plugins/a.ts', 'plugins/b.ts']);

  const singular = run(['add', '--title', 'singular scope', '--category', 'general', '--file', 'plugins/c.ts', '--json'], env);
  assert.equal(singular.status, 0, singular.stderr);
  assert.deepEqual(JSON.parse(singular.stdout).ticket.files, ['plugins/c.ts']);
});
