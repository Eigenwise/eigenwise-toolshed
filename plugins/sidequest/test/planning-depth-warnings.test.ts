import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const WARNING = 'Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.';
const MISSING_SCOPE_WARNING = 'Planning-depth warning: declared file scope does not exist in the repo: missing/scope.js.';
const PRESCRIPTIVE_HARD_WARNING = 'coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.';

function cliJson(args?: any) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\n${res.stderr}${res.stdout}`);
  return JSON.parse(res.stdout);
}

test('complexity 4+ add warns for empty executor context and file scope', () => {
  const added = cliJson([
    'add', '-t', 'underscouted add', '--complexity', '4',
    '--why', 'exercise the planning-depth warning on a complexity four ticket',
  ]);

  assert.deepStrictEqual(added.warnings, [WARNING]);
});

test('update warns when a ticket becomes complexity 4+ without planning context', () => {
  const added = cliJson([
    'add', '-t', 'rescore me', '--complexity', '3',
    '--why', 'seed a lower complexity ticket before raising its complexity score',
  ]);
  const updated = cliJson([
    'update', added.ticket.ref, '--complexity', '4',
    '--why', 'raise this ticket to four without adding any executor planning context',
  ]);

  assert.deepStrictEqual(updated.warnings, [WARNING]);
});

test('claim echoes missing planning context for dispatch visibility', () => {
  const added = cliJson([
    'add', '-t', 'claim warning', '--complexity', '4',
    '--why', 'claim a complexity four ticket to expose the dispatch context warning',
    '--label', 'direct-ok',
  ]);
  const claim = cliJson(['claim', added.ticket.ref, '--by', 'planning-warning-worker', '--direct', '--reason', 'The warning fixture requires a local direct claim.']);

  assert.deepStrictEqual(claim.warnings, [
    'Dispatch context warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.',
  ]);
});

test('add warns when declared file scope does not exist in the repo', () => {
  const added = cliJson([
    'add', '-t', 'missing scope', '--complexity', '3',
    '--why', 'exercise warning coverage for an invalid declared scope',
    '--file', 'missing/scope.js',
  ]);

  assert.deepStrictEqual(added.warnings, [MISSING_SCOPE_WARNING]);
});

test('add warns when declared output is outside the repo worktree', () => {
  const outside = path.join(path.dirname(PROJ), 'external-audition.html');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, '<main>audition</main>\n');
  const scope = outside.replace(/\\/g, '/');
  const warning = `Planning-depth warning: declared paths are outside the repo worktree: ${scope}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`;

  const added = cliJson([
    'add', '-t', 'external output', '--complexity', '3',
    '--why', 'exercise warning coverage for output outside the repository worktree',
    '--file', scope,
  ]);

  assert.deepStrictEqual(added.warnings, [warning]);
});

test('claim echoes declared file scope warning for dispatch visibility', () => {
  const added = cliJson([
    'add', '-t', 'claim missing scope', '--complexity', '3',
    '--why', 'claim a ticket with an invalid declared scope for dispatch warning',
    '--file', 'missing/scope.js',
    '--label', 'direct-ok',
  ]);
  const claim = cliJson(['claim', added.ticket.ref, '--by', 'scope-warning-worker', '--direct', '--reason', 'The scope warning fixture requires a local direct claim.']);

  assert.deepStrictEqual(claim.warnings, [
    `Dispatch context warning: ${MISSING_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`,
  ]);
});

test('claim echoes outside-worktree output guidance for dispatch visibility', () => {
  const outside = path.join(path.dirname(PROJ), 'external-dispatch-audition.html');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, '<main>audition</main>\n');
  const scope = outside.replace(/\\/g, '/');
  const added = cliJson([
    'add', '-t', 'claim external output', '--complexity', '3',
    '--why', 'claim a ticket with external output for dispatch warning coverage',
    '--file', scope,
    '--label', 'direct-ok',
  ]);
  const claim = cliJson(['claim', added.ticket.ref, '--by', 'external-scope-warning-worker', '--direct', '--reason', 'The external output fixture requires a local direct claim.']);

  assert.deepStrictEqual(claim.warnings, [
    `Dispatch context warning: declared paths are outside the repo worktree: ${scope}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`,
  ]);
});

test('add and update warn only for unknown mentioned ticket refs', () => {
  const known = cliJson(['add', '-t', 'known ref', '--unclassified']);
  const added = cliJson(['add', '-t', `follow ${known.ticket.ref}`, '--description', 'also check SQ-9999', '--unclassified']);
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.']);

  const updated = cliJson(['update', added.ticket.ref, '--title', `follow ${known.ticket.ref} and SQ-9998`]);
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9998, SQ-9999.']);
});

const PATCH_BLOCK = [
  '```diff',
  '--- a/lib/parser.js',
  '+++ b/lib/parser.js',
  '@@ -8,20 +8,24 @@',
  " const shared = require('./shared');",
  '',
  '-function parseHeader(input) {',
  "-  const parts = input.split(':');",
  '-  return { name: parts[0], value: parts[1] };',
  '-}',
  '+function parseHeader(input) {',
  "+  const parts = String(input || '').split(':');",
  '+  if (parts.length < 2) return null;',
  '+  return {',
  '+    name: parts[0].trim(),',
  "+    value: parts.slice(1).join(':').trim(),",
  '+  };',
  '+}',
  '',
  ' function parseBody(input) {',
  '   return shared.body(input);',
  ' }',
  '',
  ' module.exports = { parseHeader, parseBody };',
  '```',
].join('\n');

// A crash log that carries a source excerpt: definition-shaped on its face, and
// exactly the false positive the evidence gate has to swallow.
const CRASH_LOG_BLOCK = [
  '```',
  '$ node scripts/reindex.js',
  '/repo/lib/parser.js:12',
  'function parseHeader(input) {',
  '                    ^',
  '',
  'TypeError: input is not iterable',
  '    at parseHeader (/repo/lib/parser.js:12:21)',
  '    at Object.<anonymous> (/repo/scripts/reindex.js:8:1)',
  '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
  '    at Module._load (node:internal/modules/cjs/loader:1104:12)',
  '    at node:internal/main/run_main_module:28:49',
  '2026-07-26T09:14:02.113Z WARN reindex aborted after 3 batches',
  '2026-07-26T09:14:02.114Z INFO batches ok 3 failed 1',
  '> node --test test/parser.test.js',
  'not ok 1 - parses a legacy header',
  '  duration_ms 12.482',
  'tests 1',
  'pass 0',
  'fail 1',
  'npm ERROR code 1',
  '```',
].join('\n');

const PRESOLVED_WARNING = 'Planning-depth warning: this description embeds what looks like a complete edit; route by remaining uncertainty, so a fully resolved approach belongs on coding.easy or direct-ok, not a judgment tier.';

test('a judgment-tier ticket carrying a complete edit warns on add and update', () => {
  const added = cliJson([
    'add', '-t', 'pre-solved parser change', '--category', 'coding.normal',
    '--description', `The parser fix is already settled.\n\n${PATCH_BLOCK}\n`,
  ]);
  assert.deepStrictEqual(added.warnings, [PRESOLVED_WARNING]);

  const seeded = cliJson(['add', '-t', 'parser change', '--category', 'coding.normal', '--description', 'Work out how the parser should treat headers with no colon.']);
  assert.deepStrictEqual(seeded.warnings, []);
  const updated = cliJson(['update', seeded.ticket.ref, '--description', `Settled after the spike.\n\n${PATCH_BLOCK}\n`]);
  assert.deepStrictEqual(updated.warnings, [PRESOLVED_WARNING]);
});

test('evidence blocks and cheap tiers never trip the pre-solved warning', () => {
  const evidence = cliJson([
    'add', '-t', 'reindex crashes on legacy headers', '--category', 'debugging',
    '--description', `Reproduced on the shared board.\n\n${CRASH_LOG_BLOCK}\n`,
  ]);
  assert.deepStrictEqual(evidence.warnings, []);

  const cheap = cliJson([
    'add', '-t', 'apply the settled parser patch', '--category', 'coding.easy',
    '--description', `Mechanical: apply this.\n\n${PATCH_BLOCK}\n`,
  ]);
  assert.deepStrictEqual(cheap.warnings, []);

  const snippet = cliJson([
    'add', '-t', 'short signature note', '--category', 'coding.normal',
    '--description', 'Keep the signature:\n\n```js\nfunction parseHeader(input) {\n  return null;\n}\n```\n',
  ]);
  assert.deepStrictEqual(snippet.warnings, []);
});

test('coding.hard add warns only when the description prescribes a fix', () => {
  const prescriptive = cliJson(['add', '-t', 'prescriptive hard change', '--category', 'coding.hard', '--description', 'FIX: replace the legacy parser with the shared parser.']);
  assert.deepStrictEqual(prescriptive.warnings, [PRESCRIPTIVE_HARD_WARNING]);

  const openEnded = cliJson(['add', '-t', 'open hard change', '--category', 'coding.hard', '--description', 'Investigate the competing persistence designs and recommend a safe migration path.']);
  assert.deepStrictEqual(openEnded.warnings, []);

  const normal = cliJson(['add', '-t', 'prescriptive normal change', '--category', 'coding.normal', '--description', 'FIX: replace the legacy parser with the shared parser.']);
  assert.deepStrictEqual(normal.warnings, []);
});

export {};
