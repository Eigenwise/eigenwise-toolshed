'use strict';
/**
 * Runtime exec agent sync for enabled discovered/custom models (SQ-158).
 * Run: node --test plugins/sidequest/test/agentsync.test.js
 *
 * EVERY test below passes an explicit `dir` (a temp directory) to
 * syncExecAgents — this suite must NEVER write to (or delete from) the real
 * ~/.claude/agents directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const agentsync = require('../lib/agentsync.js');

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-'));
}

// A raw custom entry, same shape as getModelVocab/normalizeCustomEntry expect.
// `efforts` is the list of efforts turned ON; enabled defaults true (matches
// normalizeCustomEntry's own default) unless overridden via `extra`.
function mkCustom(slug, efforts, extra) {
  const row = {};
  for (const e of ALL_EFFORTS) row[e] = efforts.includes(e);
  return Object.assign({ slug, id: `id-${slug}`, anchor: 'opus', offset: 0, efforts: row }, extra || {});
}

function readDir(dir) {
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
}

/* -------------------------------------------------------------- *
 *  Correct filenames + frontmatter for enabled customs
 * -------------------------------------------------------------- */

test('syncExecAgents: writes one file per enabled custom x enabled non-max effort, with correct name/model/effort frontmatter', () => {
  const dir = tmpDir();
  const prefs = {
    custom: [
      mkCustom('codex-sol', ['high', 'xhigh'], { id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol' }),
    ],
  };
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 2, 'two enabled non-max efforts -> two files');
  assert.strictEqual(res.removed, 0);
  assert.strictEqual(res.unchanged, 0);

  const files = readDir(dir);
  assert.deepStrictEqual(files, ['sidequest-exec-codex-sol-high.md', 'sidequest-exec-codex-sol-xhigh.md']);

  const highSrc = fs.readFileSync(path.join(dir, 'sidequest-exec-codex-sol-high.md'), 'utf8');
  assert.ok(highSrc.startsWith('---\n'), 'starts with a frontmatter fence');
  const fmEnd = highSrc.indexOf('\n---\n', 4);
  assert.ok(fmEnd !== -1, 'frontmatter has a closing fence');
  const frontmatter = highSrc.slice(0, fmEnd);
  const body = highSrc.slice(fmEnd + 5);

  assert.match(frontmatter, /^name: sidequest-exec-codex-sol-high$/m);
  assert.match(frontmatter, /^effort: high$/m);
  assert.match(frontmatter, /^model: claude-codex-gpt-5\.6-sol\[1m\]$/m);
  assert.ok(body.includes(agentsync.MARKER), 'the marker line is present in the body');
  assert.match(body, /codex-sol/, 'the advisory note names the slug');
});

test('syncExecAgents: max effort is never generated even if the row enables it', () => {
  const dir = tmpDir();
  const prefs = { custom: [mkCustom('codex-y', ['high', 'max'])] };
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 1, 'only the non-max effort produces a file');
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-y-high.md']);
});

test('syncExecAgents: a custom with no enabled non-max effort writes nothing', () => {
  const dir = tmpDir();
  const prefs = { custom: [mkCustom('codex-z', ['max'])] };
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 0);
  assert.deepStrictEqual(readDir(dir), []);
});

/* -------------------------------------------------------------- *
 *  Idempotency
 * -------------------------------------------------------------- */

test('syncExecAgents: re-running with the same prefs writes nothing new (idempotent)', () => {
  const dir = tmpDir();
  const prefs = { custom: [mkCustom('codex-a', ['low', 'high'])] };
  const first = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(first.written, 2);
  const second = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(second.written, 0, 'nothing changed, so nothing is rewritten');
  assert.strictEqual(second.removed, 0);
  assert.strictEqual(second.unchanged, 2, 'both files are recognized as already correct');
});

/* -------------------------------------------------------------- *
 *  Stale marker-bearing file cleanup
 * -------------------------------------------------------------- */

test('syncExecAgents: a marker-bearing file that is no longer wanted gets removed', () => {
  const dir = tmpDir();
  const withXhigh = { custom: [mkCustom('codex-b', ['high', 'xhigh'])] };
  const first = agentsync.syncExecAgents(withXhigh, { dir });
  assert.strictEqual(first.written, 2);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-b-high.md', 'sidequest-exec-codex-b-xhigh.md']);

  // Turn xhigh off for the same slug: the xhigh file is now unwanted and
  // marker-bearing, so it must be removed; the high file is untouched.
  const highOnly = { custom: [mkCustom('codex-b', ['high'])] };
  const second = agentsync.syncExecAgents(highOnly, { dir });
  assert.strictEqual(second.removed, 1, 'the now-unwanted xhigh file is removed');
  assert.strictEqual(second.unchanged, 1, 'the still-wanted high file is untouched');
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-b-high.md']);
});

test('syncExecAgents: disabling a model removes all of its generated agent files', () => {
  const dir = tmpDir();
  const enabled = { custom: [mkCustom('codex-c', ['low', 'high', 'xhigh'])] };
  const first = agentsync.syncExecAgents(enabled, { dir });
  assert.strictEqual(first.written, 3);

  const disabled = { custom: [mkCustom('codex-c', ['low', 'high', 'xhigh'], { enabled: false })] };
  const second = agentsync.syncExecAgents(disabled, { dir });
  assert.strictEqual(second.removed, 3, 'all three of the disabled model\'s files are removed');
  assert.deepStrictEqual(readDir(dir), []);
});

/* -------------------------------------------------------------- *
 *  Never touches an unmarked file
 * -------------------------------------------------------------- */

test('syncExecAgents: never overwrites a hand-authored file at a would-be-generated path', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const collidingPath = path.join(dir, 'sidequest-exec-codex-d-high.md');
  const handAuthored = '---\nname: sidequest-exec-codex-d-high\n---\nhand-authored, not ours.\n';
  fs.writeFileSync(collidingPath, handAuthored);

  const prefs = { custom: [mkCustom('codex-d', ['high'])] };
  const res = agentsync.syncExecAgents(prefs, { dir });

  assert.strictEqual(res.written, 0, 'the colliding unmarked file is not counted as written');
  assert.strictEqual(fs.readFileSync(collidingPath, 'utf8'), handAuthored, 'content is untouched, byte-for-byte');
});

test('syncExecAgents: never deletes a hand-authored file that is not in the wanted set', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const foreignPath = path.join(dir, 'sidequest-exec-totally-unrelated-high.md');
  const handAuthored = '---\nname: totally-unrelated\n---\nnot generated by us, no marker.\n';
  fs.writeFileSync(foreignPath, handAuthored);

  // Nothing enabled at all -> the wanted set is empty, but the foreign file
  // must survive because it carries no marker.
  const res = agentsync.syncExecAgents({ custom: [] }, { dir });
  assert.strictEqual(res.removed, 0);
  assert.ok(fs.existsSync(foreignPath), 'the unmarked foreign file still exists');
  assert.strictEqual(fs.readFileSync(foreignPath, 'utf8'), handAuthored);
});

/* -------------------------------------------------------------- *
 *  Multiple enabled customs at once
 * -------------------------------------------------------------- */

test('syncExecAgents: multiple enabled customs each get their own files; a disabled one is skipped entirely', () => {
  const dir = tmpDir();
  const prefs = {
    custom: [
      mkCustom('codex-e', ['high']),
      mkCustom('codex-f', ['low', 'medium']),
      mkCustom('codex-g', ['high'], { enabled: false }),
    ],
  };
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 3, '1 (codex-e) + 2 (codex-f); codex-g is disabled and contributes nothing');
  assert.deepStrictEqual(readDir(dir), [
    'sidequest-exec-codex-e-high.md',
    'sidequest-exec-codex-f-low.md',
    'sidequest-exec-codex-f-medium.md',
  ]);
});
