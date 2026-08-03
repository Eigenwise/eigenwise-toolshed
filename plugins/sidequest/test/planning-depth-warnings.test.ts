import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const store = require('../lib/store');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const WARNING = 'Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.';
const MISSING_SCOPE_WARNING = 'Planning-depth warning: declared file scope does not exist in the repo: missing/scope.js.';
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.';
const PRESCRIPTIVE_HARD_WARNING = 'coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.';
const BUILD_OUTPUT_WARNING = 'Planning-depth warning: declared source scope under ./src omits tracked build output lib. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.';
const READONLY_BROWSER_WARNING = 'Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.';
const VERIFY_WARNING = 'Planning-depth warning: record verify commands as `cd <repo-relative-dir> && ...`, then run that exact string before submitting.';

function cliJson(args?: any) {
  return cliJsonAt(PROJ, args);
}

function cliJsonAt(project: any, args: any[]) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: project });
  const res = spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\n${res.stderr}${res.stdout}`);
  return JSON.parse(res.stdout);
}

function cliResult(args: any[]) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  return spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
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
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.', NO_SCOPE_WARNING]);

  const updated = cliJson(['update', added.ticket.ref, '--title', `follow ${known.ticket.ref} and SQ-9998`]);
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9998.', NO_SCOPE_WARNING]);

  const filesOnly = cliJson(['update', added.ticket.ref, '--files', 'src/changed.ts']);
  assert.deepStrictEqual(filesOnly.warnings, ['Planning-depth warning: declared file scope does not exist in the repo: src/changed.ts.']);
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
  assert.deepStrictEqual(added.warnings, [PRESOLVED_WARNING, NO_SCOPE_WARNING]);

  const seeded = cliJson(['add', '-t', 'parser change', '--category', 'coding.normal', '--description', 'Work out how the parser should treat headers with no colon.']);
  assert.deepStrictEqual(seeded.warnings, [NO_SCOPE_WARNING]);
  const updated = cliJson(['update', seeded.ticket.ref, '--description', `Settled after the spike.\n\n${PATCH_BLOCK}\n`]);
  assert.deepStrictEqual(updated.warnings, [PRESOLVED_WARNING, NO_SCOPE_WARNING]);
});

test('evidence blocks and cheap tiers never trip the pre-solved warning', () => {
  const evidence = cliJson([
    'add', '-t', 'reindex crashes on legacy headers', '--category', 'debugging',
    '--description', `Reproduced on the shared board.\n\n${CRASH_LOG_BLOCK}\n`,
  ]);
  assert.deepStrictEqual(evidence.warnings, [NO_SCOPE_WARNING]);

  const cheap = cliJson([
    'add', '-t', 'apply the settled parser patch', '--category', 'coding.easy',
    '--description', `Mechanical: apply this.\n\n${PATCH_BLOCK}\n`,
  ]);
  assert.deepStrictEqual(cheap.warnings, [NO_SCOPE_WARNING]);

  const snippet = cliJson([
    'add', '-t', 'short signature note', '--category', 'coding.normal',
    '--description', 'Keep the signature:\n\n```js\nfunction parseHeader(input) {\n  return null;\n}\n```\n',
  ]);
  assert.deepStrictEqual(snippet.warnings, [NO_SCOPE_WARNING]);
});

test('coding.hard add warns only when the description prescribes a fix', () => {
  const prescriptive = cliJson(['add', '-t', 'prescriptive hard change', '--category', 'coding.hard', '--description', 'FIX: replace the legacy parser with the shared parser.']);
  assert.deepStrictEqual(prescriptive.warnings, [PRESCRIPTIVE_HARD_WARNING, NO_SCOPE_WARNING]);

  const openEnded = cliJson(['add', '-t', 'open hard change', '--category', 'coding.hard', '--description', 'Investigate the competing persistence designs and recommend a safe migration path.']);
  assert.deepStrictEqual(openEnded.warnings, [NO_SCOPE_WARNING]);

  const normal = cliJson(['add', '-t', 'prescriptive normal change', '--category', 'coding.normal', '--description', 'FIX: replace the legacy parser with the shared parser.']);
  assert.deepStrictEqual(normal.warnings, [NO_SCOPE_WARNING]);
});

test('add warns for a write-scope ticket with no declared files, not when files are declared or the category is readonly', () => {
  const scopedFile = path.join(PROJ, 'lib', 'existing.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'existing\n');

  const noFiles = cliJson(['add', '-t', 'no scope declared', '--category', 'coding.normal', '--description', 'Add a thing.']);
  assert.deepStrictEqual(noFiles.warnings, [NO_SCOPE_WARNING]);

  const withFiles = cliJson(['add', '-t', 'scope declared', '--category', 'coding.normal', '--description', 'Add a thing.', '--file', 'lib/existing.js']);
  assert.deepStrictEqual(withFiles.warnings, []);

  const readonly = cliJson(['add', '-t', 'readonly ticket', '--category', 'source-lookup', '--description', 'Look something up.']);
  assert.deepStrictEqual(readonly.warnings, []);
});

test('warns when tracked package build output is omitted from source scope', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'tracked-output');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(project, 'scripts', 'build.mjs'), [
    'async function buildOutput(directory) {',
    '  return { outdir: path.join(root, directory) };',
    '}',
    "buildOutput('lib');",
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'src', 'lib', 'store.ts'), 'export {};\n');
  fs.writeFileSync(path.join(project, 'lib', 'store.js'), 'module.exports = {};\n');
  assert.strictEqual(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: project, encoding: 'utf8' }).status, 0);

  const omitted = cliJsonAt(project, ['add', '-t', 'source change', '--category', 'coding.normal', '--file', 'src/lib/store.ts']);
  assert.deepStrictEqual(omitted.warnings, [BUILD_OUTPUT_WARNING]);

  const included = cliJsonAt(project, ['add', '-t', 'source and output change', '--category', 'coding.normal', '--file', 'src/lib/store.ts', '--file', 'lib/store.js']);
  assert.deepStrictEqual(included.warnings, []);
});

test('warns only when a readonly ticket signals browser or visual work', () => {
  const browser = cliJson(['add', '-t', 'visual review', '--category', 'source-lookup', '--description', 'Open the browser and take a screenshot.']);
  assert.deepStrictEqual(browser.warnings, [READONLY_BROWSER_WARNING]);

  const ordinary = cliJson(['add', '-t', 'read docs', '--category', 'source-lookup', '--description', 'Read the existing docs.']);
  assert.deepStrictEqual(ordinary.warnings, []);
});

test('rejects prose verification while preserving commands and recording manual checks', () => {
  const scopedFile = path.join(PROJ, 'lib', 'verify.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'verify\n');

  const command = cliJson(['add', '-t', 'command verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . && node --test "lib/verify.js"']);
  assert.strictEqual(command.ticket.executorVerify, 'cd . && node --test "lib/verify.js"');

  const multiline = cliJson(['add', '-t', 'multiline verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . &&\nnode --test "lib/verify.js"']);
  assert.strictEqual(multiline.ticket.executorVerify, 'cd . &&\nnode --test "lib/verify.js"');

  const prose = cliResult(['add', '-t', 'prose verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'Read the rendered page source and confirm the required points.']);
  assert.strictEqual(prose.status, 1);
  assert.match(prose.stderr + prose.stdout, /cd <repo-relative-dir> && <command>/);
  assert.match(prose.stderr + prose.stdout, /manual: <what you checked>/);

  const manual = cliJson(['add', '-t', 'manual verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'manual: Reviewed the rendered page and reference output.']);
  assert.strictEqual(manual.ticket.executorVerify, 'manual: Reviewed the rendered page and reference output.');

  const unsetVariable = cliResult(['update', command.ticket.ref, '--verify', 'cd . && node --test "$SIDEQUEST_VERIFY_UNSET_TEST"']);
  assert.strictEqual(unsetVariable.status, 1);
  assert.match(unsetVariable.stderr + unsetVariable.stdout, /SIDEQUEST_VERIFY_UNSET_TEST/);
});

test('warns for an unrunnable recorded verify command, not a cd-prefixed one', () => {
  const scopedFile = path.join(PROJ, 'lib', 'verify.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'verify\n');

  const bare = cliJson(['add', '-t', 'bare verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'node --test']);
  assert.deepStrictEqual(bare.warnings, [VERIFY_WARNING]);

  const exact = cliJson(['add', '-t', 'exact verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . && node --test']);
  assert.deepStrictEqual(exact.warnings, []);
});

test('dispatch rejects broken npm and node test verifies while add and update only warn', () => {
  const packageDir = path.join(PROJ, 'plugins', 'package-suite');
  const bareDir = path.join(PROJ, 'plugins', 'bare-suite');
  fs.mkdirSync(path.join(packageDir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(bareDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node --test "test/*.test.js"' } }));
  fs.writeFileSync(path.join(packageDir, 'test', 'suite.test.js'), '');
  fs.writeFileSync(path.join(bareDir, 'test', 'suite.test.js'), '');

  const npmTest = cliJson(['add', '-t', 'missing npm manifest', '--category', 'coding.normal', '--description', 'Verify the fixture command before dispatching so this description satisfies the executor briefing requirement.', '--file', 'plugins/bare-suite/test/suite.test.js', '--verify', 'cd plugins/bare-suite && npm test']);
  assert.match(npmTest.warnings.join('\n'), /npm test.*package\.json/);
  assert.match(store.dispatchVerifyCommandError(npmTest.ticket, PROJ), /cd plugins\/bare-suite && node --test "test\/\*\.test\.js"/);

  const missingScript = cliJson(['add', '-t', 'missing npm script', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.match(missingScript.warnings.join('\n'), /npm run missing.*`missing` script/);
  assert.match(store.dispatchVerifyCommandError(missingScript.ticket, PROJ), /cd plugins\/package-suite && npm run test:full/);

  const updatedScript = cliJson(['update', missingScript.ticket.ref, '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.match(updatedScript.warnings.join('\n'), /npm run missing.*`missing` script/);

  const emptyGlob = cliJson(['add', '-t', 'empty test glob', '--category', 'coding.normal', '--file', 'plugins/bare-suite/test/suite.test.js', '--verify', 'cd plugins/bare-suite && node --test "test/missing.test.js"']);
  assert.match(emptyGlob.warnings.join('\n'), /matches no files/);
  assert.match(store.dispatchVerifyCommandError(emptyGlob.ticket, PROJ), /matches no files/);

  const correct = cliJson(['add', '-t', 'working verify', '--category', 'coding.normal', '--description', 'Verify the fixture command before dispatching so this description satisfies the executor briefing requirement.', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full']);
  assert.deepStrictEqual(correct.warnings, []);
  assert.strictEqual(store.dispatchVerifyCommandError(correct.ticket, PROJ), null);

  const refusedDispatch = cliResult(['dispatch', npmTest.ticket.ref]);
  assert.strictEqual(refusedDispatch.status, 1);
  assert.match(refusedDispatch.stderr + refusedDispatch.stdout, /dispatch: verify command cannot run/);

  const correctDispatch = cliResult(['dispatch', correct.ticket.ref]);
  assert.strictEqual(correctDispatch.status, 1);
  assert.doesNotMatch(correctDispatch.stderr + correctDispatch.stdout, /dispatch: verify command cannot run/);

  const manual = cliJson(['add', '-t', 'manual verify survives dispatch', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'manual: Checked the test plan.']);
  assert.deepStrictEqual(manual.warnings, []);
  assert.strictEqual(store.dispatchVerifyCommandError(manual.ticket, PROJ), null);
});

export {};
