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
    ['done', '--verify'],
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

test('worktree sweep help and retention docs use the classification order and the real thresholds', () => {
  const worktrees = require('../lib/worktrees');
  const order = worktrees.WORKTREE_SWEEP_CLASSIFICATION_ORDER as string[];
  const hours = (milliseconds: number) => milliseconds / (60 * 60 * 1000);
  const thresholds = [
    `${hours(worktrees.DEFAULT_MIN_AGE_MS)} hours`,
    `${hours(worktrees.DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_MS) / 24} days`,
    `${hours(worktrees.DEFAULT_RECOVERY_RETENTION_AGE_MS) / 24} days`,
  ];
  assert.deepEqual(thresholds, ['3 hours', '7 days', '14 days'], 'the shipped defaults are what every surface promises');
  assert.equal(worktrees.DEFAULT_RECOVERY_RETENTION_MAX_PER_AGENT, undefined, 'retention is age alone, so no per-agent cap is exported');
  const help = run(['worktrees', '--help'], isolatedEnv());
  assert.equal(help.status, 0, help.stderr);
  const topLevelHelp = run(['--help'], isolatedEnv());
  assert.equal(topLevelHelp.status, 0, topLevelHelp.stderr);
  const texts = [
    help.stdout,
    fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8'),
    fs.readFileSync(path.resolve(ROOT, '..', '..', 'docs', 'src', 'content', 'docs', 'getting-started', 'sidequest.md'), 'utf8'),
  ];
  for (const text of texts) {
    let previous = -1;
    for (const reason of order) {
      const index = text.indexOf(reason, previous + 1);
      assert.ok(index > previous, `${reason} follows the preceding sweep reason`);
      previous = index;
    }
    for (const threshold of thresholds) assert.ok(text.includes(threshold), `the sweep surface names its ${threshold} threshold`);
    assert.doesNotMatch(text, /per agent|per-agent|three entries/i, 'the per-agent quarantine cap is gone');
  }
  // The reclaim rule renders into the top-level help as well, and an agent acts on whichever surface
  // it read, so all four make the same promise and name the same limits (SQ-2958, SQ-2963).
  for (const text of [...texts, topLevelHelp.stdout]) {
    assert.ok(text.includes('node_modules'), 'the sweep surface names the node_modules exception');
    assert.match(text, /regenerat/, 'the sweep surface says worktree setup regenerates that cache');
    assert.match(text, /renamed into quarantine/, 'the sweep surface states the rename-first rule');
    // A one-time re-read is not an atomic deletion condition, and the surfaces used to promise it
    // was: an agent read "anything written while the sweep ran stays parked" and acted on it, while
    // a file written after that read was deleted with the moved copy (SQ-2962).
    assert.doesNotMatch(text, /anything written while the sweep ran stays parked|deleted only if it is still the clean tree that was classified/, 'no sweep surface promises an atomic delete');
    assert.match(text, /re-read once before its files are deleted/, 'the sweep surface says the moved copy is read once more, not continuously');
    assert.match(text, /in the instant after that read is deleted with it/, 'the sweep surface names the window it cannot protect');
    assert.ok(text.includes('update-ref -d'), 'the sweep surface names the compare-and-delete that keeps a commit');
    assert.ok(text.includes('tip_moved'), 'the sweep surface names the reason a moved ref keeps its branch');
    // The compare is one value against one branch ref, so the unconditional promise these surfaces
    // used to make was false for a commit on a detached HEAD nothing pinned, and for a ref that moved
    // away and back to the same tip. Every surface names both limits (SQ-2982).
    assert.doesNotMatch(text, /a commit is never lost/, 'no sweep surface promises an unconditional commit guarantee');
    assert.match(text, /own branch is not lost/, 'the sweep surface scopes the guarantee to the branch it compares');
    assert.match(text, /back to the same tip is not detected/, 'the sweep surface names the ABA limit of a value comparison');
    // An unpinned detached HEAD is now retained rather than disclaimed, so the surfaces have to say
    // which detached commit is kept and which one is still outside the promise (SQ-2985).
    assert.doesNotMatch(text, /detached HEAD that no ref holds is not covered/, 'no sweep surface still disclaims the detached commit it now retains');
    assert.ok(text.includes('detached_head_unpinned'), 'the sweep surface names the reason an unheld detached HEAD keeps its checkout');
    assert.match(text, /never reclaimed on ticket status alone/, 'the sweep surface says a terminal ticket does not override an observed detached commit');
    assert.match(text, /probe that cannot answer keeps the tree/, 'the sweep surface says the reachability probe fails closed');
    // The pin probe used to accept a branch the same sweep would prune and a per-worktree ref of the
    // checkout doing the asking, and a park kept the files while the prune took the commit. The
    // surfaces said neither, and named a loss that no longer happens (SQ-2986).
    assert.doesNotMatch(text, /pruning the removed tree's private metadata leaves it unreachable/, 'no sweep surface still says a parked tree loses its commit');
    assert.ok(text.includes('refs/worktree/'), 'the sweep surface names the per-worktree namespaces that are not pin authority');
    assert.match(text, /orphan pass may take once the reclaims are done/, 'the sweep surface says the deletion plan the probe excludes includes orphan branches');
    assert.match(text, /park runs `?git worktree repair`? against the quarantine destination/, 'the sweep surface names how a park keeps its registration');
    assert.match(text, /repair that cannot be confirmed withholds every repository prune until a later sweep repairs every retained park/, 'the sweep surface says retained repair failures persist across sweeps');
    assert.match(text, /Expiry removes quarantine files with link-safe filesystem deletion/, 'the sweep surface says expiry cannot follow a parked link');
    assert.match(text, /metadata-only prune remove their registrations, otherwise that metadata cleanup is reported as deferred/, 'the sweep surface says expiry defers unsafe metadata cleanup');
    assert.match(text, /commit made on a detached HEAD after those reads/, 'the sweep surface names the detached window it still cannot protect');
    assert.ok(text.includes('refs/sidequest/'), 'the sweep surface says why a review\'s detached checkout still reclaims');
    assert.match(text, /holding the tree open makes the rename fail/, 'the sweep surface names the Windows open-handle outcome');
    assert.ok(text.includes('quarantine_failed'), 'the sweep surface names the cross-volume outcome');
  }
});

test('worktree sweep sends live classification progress to stderr for JSON output', () => {
  const env = isolatedEnv();
  const project = String(env.CLAUDE_PROJECT_DIR);
  const worktree = path.join(project, '.claude', 'worktrees', 'agent-json-progress');
  runGit(project, ['init', '-b', 'main']);
  runGit(project, ['config', 'user.name', 'Sidequest Test']);
  runGit(project, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  runGit(project, ['add', 'README.md']);
  runGit(project, ['commit', '-m', 'fixture']);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(project, ['worktree', 'add', '-b', 'worktree-agent-json-progress', worktree, 'HEAD']);
  try {
    const configured = run(['board-config', '--project', project, '--integration-branch', 'main', '--json'], env);
    assert.equal(configured.status, 0, configured.stderr);

    const result = run(['worktrees', 'sweep', '--project', project, '--json'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).entries.length, 1);
    assert.match(result.stderr, /worktrees sweep: classifying 0\/1: .*agent-json-progress; planned 0, removed 0/);
    // A worktree cut moments ago is now kept for its age, not for its missing lease:
    // legacy status stopped being a keep reason (SQ-2924).
    assert.match(result.stderr, /worktrees sweep: classifying 1\/1: .*agent-json-progress \(too_young\); planned 0, removed 0/);
  } finally {
    if (fs.existsSync(worktree)) runGit(project, ['worktree', 'remove', '--force', worktree]);
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

test('CLI --add-file appends to declared files, and mixing it with --file refuses', () => {
  const env = isolatedEnv();
  const added = run(['add', '--title', 'scope append ticket', '--unclassified', '--file', 'src/a.js', '--json'], env);
  assert.equal(added.status, 0, added.stderr);

  const updated = run(['update', 'SQ-1', '--add-file', 'src/b.js', '--json'], env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout).ticket.files, ['src/a.js', 'src/b.js']);

  const removed = run(['update', 'SQ-1', '--remove-file', 'src/a.js', '--json'], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).ticket.files, ['src/b.js']);

  const mixed = run(['update', 'SQ-1', '--file', 'src/c.js', '--add-file', 'src/d.js'], env);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /cannot be combined/);
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
