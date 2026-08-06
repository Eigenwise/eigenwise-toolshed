import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const store = require('../lib/store');
const { resolveSuite } = require('../lib/suite-resolver');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const WARNING = 'Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.';
const MISSING_SCOPE_WARNING = 'Planning-depth warning: declared file scope does not exist in the repo: missing/scope.js.';
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.';
const PRESCRIPTIVE_HARD_WARNING = 'coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.';
const BUILD_OUTPUT_WARNING = 'Planning-depth warning: declared source scope under ./src omits tracked build output lib. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.';
const HOOK_BUILD_OUTPUT_WARNING = 'Planning-depth warning: declared source scope under ./src omits tracked build output hooks. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.';
const READONLY_BROWSER_WARNING = 'Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.';
const QUANTITATIVE_PREMISE_WARNING = 'Planning-depth warning: this coding ticket relies on a quantitative or behavioral claim without measurement evidence. Include the command, output, and where it ran, or link the measurement ticket; otherwise file measurement work before the fix.';

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

test('add warns when declared file scope does not exist in an established directory', () => {
  fs.mkdirSync(path.join(PROJ, 'missing'), { recursive: true });
  const added = cliJson([
    'add', '-t', 'missing scope', '--complexity', '3',
    '--why', 'exercise warning coverage for an invalid declared scope',
    '--file', 'missing/scope.js',
  ]);

  assert.deepStrictEqual(added.warnings, [MISSING_SCOPE_WARNING]);
});

test('add stays quiet for a greenfield scope whose parent directory does not exist', () => {
  const added = cliJson([
    'add', '-t', 'greenfield scope', '--complexity', '3',
    '--why', 'create a new source subtree in a project that does not have one yet',
    '--file', 'greenfield/src/entry.ts',
  ]);

  assert.deepStrictEqual(added.warnings, []);
});

test('add and update warn for nonexistent executor anchor paths without refusing the write', () => {
  fs.mkdirSync(path.join(PROJ, 'anchor-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'anchor-fixtures', 'target.js'), 'const targetSymbol = true;\n');
  const missingWarning = 'Planning-depth warning: executor anchor references path absent from this repo: anchor-fixtures/missing.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.';
  const added = cliJson([
    'add', '-t', 'missing anchor path', '--complexity', '3',
    '--why', 'persist the ticket while exposing a stale anchor for correction',
    '--file', 'anchor-fixtures/target.js', '--anchors', 'targetSymbol is at anchor-fixtures/missing.js:8',
  ]);

  assert.deepStrictEqual(added.warnings, [missingWarning]);
  assert.equal(added.ticket.executorAnchors, 'targetSymbol is at anchor-fixtures/missing.js:8');

  const updated = cliJson([
    'update', added.ticket.ref, '--anchors', 'targetSymbol is at anchor-fixtures/also-missing.js:8',
  ]);

  assert.deepStrictEqual(updated.warnings, [
    'Planning-depth warning: executor anchor references path absent from this repo: anchor-fixtures/also-missing.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
  ]);
  assert.equal(updated.ticket.executorAnchors, 'targetSymbol is at anchor-fixtures/also-missing.js:8');
});

test('a symbol anchor warns when its existing file does not contain that symbol', () => {
  fs.mkdirSync(path.join(PROJ, 'anchor-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'anchor-fixtures', 'wrong-symbol.js'), 'const actualSymbol = true;\n');
  const added = cliJson([
    'add', '-t', 'wrong anchor symbol', '--complexity', '3',
    '--why', 'name the stale symbol and its existing but incorrect file',
    '--file', 'anchor-fixtures/wrong-symbol.js', '--anchors', '`requestedSymbol` is at `anchor-fixtures/wrong-symbol.js`:3',
  ]);

  assert.deepStrictEqual(added.warnings, [
    'Planning-depth warning: executor anchor says requestedSymbol is in anchor-fixtures/wrong-symbol.js, but requestedSymbol does not appear in that file.',
  ]);
});

test('correct executor anchors stay quiet', () => {
  fs.mkdirSync(path.join(PROJ, 'anchor-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'anchor-fixtures', 'correct-symbol.js'), 'function presentSymbol() {}\n');
  const added = cliJson([
    'add', '-t', 'correct anchor', '--complexity', '3',
    '--why', 'keep valid repository orientation free of planning-depth noise',
    '--file', 'anchor-fixtures/correct-symbol.js', '--anchors', 'presentSymbol in anchor-fixtures/correct-symbol.js',
  ]);

  assert.deepStrictEqual(added.warnings, []);
});

test('a greenfield declared anchor warns without refusing the ticket write', () => {
  const added = cliJson([
    'add', '-t', 'greenfield anchor', '--complexity', '3',
    '--why', 'allow a future declared file while still marking the unverified anchor',
    '--file', 'greenfield-anchor/src/entry.js', '--anchors', 'createEntry is at greenfield-anchor/src/entry.js:1',
  ]);

  assert.deepStrictEqual(added.warnings, [
    'Planning-depth warning: executor anchor references path absent from this repo: greenfield-anchor/src/entry.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
  ]);
  assert.equal(added.ticket.executorAnchors, 'createEntry is at greenfield-anchor/src/entry.js:1');
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
  fs.mkdirSync(path.join(PROJ, 'missing'), { recursive: true });
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

  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
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

test('quantitative premise warnings require evidence without nagging measurement work', () => {
  const unevidenced = cliJson([
    'add', '-t', 'lower an unmeasured threshold', '--category', 'coding.normal',
    '--description', 'The river folding threshold is 100 and causes a retry rate.',
    '--file', 'quantitative-fixtures/src/threshold.ts', '--verify', 'manual: Measure the retry rate after the fix.',
  ]);
  assert.deepStrictEqual(unevidenced.warnings, [QUANTITATIVE_PREMISE_WARNING]);
  assert.deepStrictEqual(store.dispatchWarnings(unevidenced.ticket), [
    `Dispatch warning: ${QUANTITATIVE_PREMISE_WARNING.replace('Planning-depth warning: ', '')}`,
  ]);

  const measurement = cliJson(['add', '-t', 'measure river folding', '--category', 'source-lookup', '--description', 'Measure the retry rate before selecting a threshold.']);
  const cited = cliJson([
    'add', '-t', 'lower a measured threshold', '--category', 'coding.normal',
    '--description', `Measured in ${measurement.ticket.ref}: \`node scripts/measure-river.js\` on CI produced a 75% retry rate.`,
    '--file', 'quantitative-fixtures/src/measured-threshold.ts',
  ]);
  assert.deepStrictEqual(cited.warnings, []);

  const readonly = cliJson([
    'add', '-t', 'measure river folding again', '--category', 'source-lookup',
    '--description', 'The threshold is too high and causes a 75% retry rate.',
  ]);
  assert.deepStrictEqual(readonly.warnings, []);
});

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

test('discovers bundled hook output from the build script export', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'bundled-hook-output');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(project, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(project, 'scripts', 'build.mjs'), [
    'export const bundledBuildOutputs = [{',
    "  sourceDirectory: 'src/hooks',",
    "  outputDirectory: 'hooks',",
    "  sourceExtension: '.ts',",
    "  outputExtension: '.js',",
    '}];',
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'src', 'hooks', 'subagent-stop.ts'), 'export {};\n');
  fs.writeFileSync(path.join(project, 'hooks', 'subagent-stop.js'), 'module.exports = {};\n');
  assert.strictEqual(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: project, encoding: 'utf8' }).status, 0);

  const omitted = cliJsonAt(project, ['add', '-t', 'hook source change', '--category', 'coding.normal', '--file', 'src/hooks/subagent-stop.ts']);
  assert.deepStrictEqual(omitted.warnings, [HOOK_BUILD_OUTPUT_WARNING]);

  const outputOnly = cliJsonAt(project, ['add', '-t', 'hook output change', '--category', 'coding.normal', '--file', 'hooks/subagent-stop.js']);
  assert.deepStrictEqual(outputOnly.warnings, []);
});

test('warns only for visual-evaluation and legacy visual-review categories', () => {
  const visualEvaluation = cliJson(['add', '-t', 'rendered flow review', '--category', 'visual-evaluation', '--description', 'Review the rendered flow.']);
  assert.deepStrictEqual(visualEvaluation.warnings, [READONLY_BROWSER_WARNING]);

  cliJson(['category', 'add', 'visual-review', '--route-model', 'sonnet', '--route-effort', 'high', '--no-fallback', '--readonly', 'true']);
  const visualReview = cliJson(['add', '-t', 'legacy rendered flow review', '--category', 'visual-review', '--description', 'Review the rendered flow.']);
  assert.deepStrictEqual(visualReview.warnings, [READONLY_BROWSER_WARNING]);

  const incidental = cliJson(['add', '-t', 'source lookup', '--category', 'source-lookup', '--description', 'Open the browser and take a screenshot.']);
  assert.deepStrictEqual(incidental.warnings, []);

  const ordinary = cliJson(['add', '-t', 'read docs', '--category', 'source-lookup', '--description', 'Read the existing docs.']);
  assert.deepStrictEqual(ordinary.warnings, []);
});

test('rejects prose verification while preserving commands and recording manual checks', () => {
  const scopedFile = path.join(PROJ, 'lib', 'verify.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'verify\n');

  const command = cliJson(['add', '-t', 'command verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . && node --test "lib/verify.js"']);
  assert.strictEqual(command.ticket.executorVerify, 'cd . && node --test "lib/verify.js"');

  const newline = cliResult(['add', '-t', 'newline verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . &&\nnode --test "lib/verify.js"']);
  assert.strictEqual(newline.status, 1);
  assert.match(newline.stderr + newline.stdout, /one runnable command line/);

  const prose = cliResult(['add', '-t', 'prose verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'Read the rendered page source and confirm the required points.']);
  assert.strictEqual(prose.status, 1);
  assert.match(prose.stderr + prose.stdout, /cd <repo-relative-dir> && <command>/);
  assert.match(prose.stderr + prose.stdout, /manual: <what you checked>/);

  for (const verify of ['pytest -;', 'node --test <scratchpad>/future.test.ts', 'npm test; pytest']) {
    const invalid = cliResult(['add', '-t', 'invalid verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', verify]);
    assert.strictEqual(invalid.status, 1, verify);
    assert.match(invalid.stderr + invalid.stdout, /runnable command|placeholder|chaining/);
  }

  const manual = cliJson(['add', '-t', 'manual verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'manual: Reviewed the rendered page and reference output.']);
  assert.strictEqual(manual.ticket.executorVerify, 'manual: Reviewed the rendered page and reference output.');

  const unsetVariable = cliResult(['update', command.ticket.ref, '--verify', 'cd . && node --test "$SIDEQUEST_VERIFY_UNSET_TEST"']);
  assert.strictEqual(unsetVariable.status, 1);
  assert.match(unsetVariable.stderr + unsetVariable.stdout, /SIDEQUEST_VERIFY_UNSET_TEST/);
});

test('accepts repository-root and subdirectory verify commands', () => {
  const scopedFile = path.join(PROJ, 'lib', 'verify.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'verify\n');

  const rootCommand = 'cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure';
  const root = cliJson(['add', '-t', 'root verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', rootCommand]);
  assert.strictEqual(root.ticket.executorVerify, rootCommand);
  assert.deepStrictEqual(root.warnings, []);

  const subdirectory = cliJson(['add', '-t', 'subdirectory verify', '--category', 'coding.normal', '--file', 'lib/verify.js', '--verify', 'cd . && node --test']);
  assert.deepStrictEqual(subdirectory.warnings, []);
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
  assert.match(store.dispatchVerifyCommandError(npmTest.ticket, PROJ), /cd plugins\/bare-suite && node --test --test-timeout=\d+ "test\/\*\.test\.js"/);

  const missingScript = cliJson(['add', '-t', 'missing npm script', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.match(missingScript.warnings.join('\n'), /npm run missing.*`missing` script/);
  assert.match(store.dispatchVerifyCommandError(missingScript.ticket, PROJ), /cd plugins\/package-suite && npm run test:full/);

  const updatedScript = cliJson(['update', missingScript.ticket.ref, '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.match(updatedScript.warnings.join('\n'), /npm run missing.*`missing` script/);

  const emptyGlob = cliJson(['add', '-t', 'empty test glob', '--category', 'coding.normal', '--file', 'plugins/bare-suite/test/suite.test.js', '--verify', 'cd plugins/bare-suite && node --test "test/missing.test.js"']);
  assert.match(emptyGlob.warnings.join('\n'), /matches no files/);
  assert.match(store.dispatchVerifyCommandError(emptyGlob.ticket, PROJ), /matches no files/);

  const derivedSuite = resolveSuite(PROJ, { name: 'bare-suite', dir: 'plugins/bare-suite' });
  assert.ok(derivedSuite);
  const derivedVerify = `cd ${derivedSuite.cwd} && ${derivedSuite.command}`;
  const derived = cliJson(['add', '-t', 'derived suite verify', '--category', 'coding.normal', '--description', 'Dispatch the resolver-derived command so this description satisfies the executor briefing requirement.', '--file', 'plugins/bare-suite/test/suite.test.js', '--verify', derivedVerify]);
  assert.strictEqual(store.dispatchVerifyCommandError(derived.ticket, PROJ), null);
  const derivedDispatch = cliResult(['dispatch', derived.ticket.ref]);
  assert.strictEqual(derivedDispatch.status, 1);
  assert.doesNotMatch(derivedDispatch.stderr + derivedDispatch.stdout, /dispatch: verify command cannot run/);

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
