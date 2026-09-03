import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const store = require('../lib/store');

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

function runGit(project: string, arguments_: string[]): string {
  const result = spawnSync('git', arguments_, {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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
    ['watch', '--interval'],
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

test('groom-close records a delivered commit through the shared store transition', () => {
  const env = isolatedEnv();
  const project = String(env.CLAUDE_PROJECT_DIR);
  runGit(project, ['init', '-b', 'main']);
  runGit(project, ['config', 'user.name', 'Sidequest Test']);
  runGit(project, ['config', 'user.email', 'sidequest@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), 'delivered\n');
  runGit(project, ['add', 'README.md']);
  runGit(project, ['commit', '-m', 'delivered fixture']);
  const deliveredCommit = runGit(project, ['rev-parse', 'HEAD']);

  const added = run(['add', '--title', 'delivered ticket', '--unclassified', '--json'], env);
  assert.equal(added.status, 0, added.stderr);

  const closed = run([
    'groom-close', 'SQ-1', '--delivery-commit', deliveredCommit,
    '--reason', 'Delivered fixture commit reached main and passed its check.',
    '--by', 'cli-delivery-test', '--json',
  ], env);
  assert.equal(closed.status, 0, closed.stderr);
  const ticket = JSON.parse(closed.stdout).ticket;
  assert.equal(ticket.status, 'done');
  assert.equal(ticket.completion.delivery.commit, deliveredCommit);
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

test('CLI never grants live-claim closeout updates from by, source, or session identity', () => {
  const env = isolatedEnv();
  const added = run(['add', '--title', 'live ticket', '--unclassified', '--file', 'src/engine.js', '--json'], env);
  assert.equal(added.status, 0, added.stderr);
  const ticket = JSON.parse(added.stdout).ticket;
  const previousHome = process.env.SIDEQUEST_HOME;
  const previousProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.SIDEQUEST_HOME = String(env.SIDEQUEST_HOME);
  process.env.CLAUDE_PROJECT_DIR = String(env.CLAUDE_PROJECT_DIR);
  try {
    const slug = store.ensureProject(String(env.CLAUDE_PROJECT_DIR)).slug;
    assert.equal(store.claimTicket(slug, ticket.ref, 'cli-closeout-executor', {
      direct: true,
      reason: 'The CLI closeout-update fixture needs a live local claim.',
      sessionId: 'cli-closeout-orchestrator',
    }).ok, true);
  } finally {
    if (previousHome === undefined) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProject;
  }

  const attempts = [
    ['update', ticket.ref, '--external-deliverable', '--json'],
    ['update', ticket.ref, '--external-deliverable', '--source', 'mcp', '--json'],
    ['update', ticket.ref, '--external-deliverable', '--by', 'forged-control-plane', '--json'],
  ];
  for (const args of attempts) {
    const refused = run(args, { ...env, CLAUDE_CODE_SESSION_ID: 'cli-closeout-orchestrator' });
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /release the claim.*MCP `update`.*orchestrator's main thread/i);
  }

  const unclaimed = run(['add', '--title', 'unclaimed ticket', '--unclassified', '--file', 'src/unclaimed.js', '--json'], env);
  assert.equal(unclaimed.status, 0, unclaimed.stderr);
  const unclaimedRef = JSON.parse(unclaimed.stdout).ticket.ref;
  const accepted = run(['update', unclaimedRef, '--external-deliverable', '--json'], env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).ticket.externalDeliverable, true);

  const help = run(['update', '--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /live-claim closeout fields require releasing the claim first or using MCP update from the orchestrator main thread/i);
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
