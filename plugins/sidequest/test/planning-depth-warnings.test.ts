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
const { tools: mcpTicketTools } = require('../lib/mcp-tickets');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-claude-'));
fs.mkdirSync(path.join(CLAUDE_HOME, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: {
    'sidequest@eigenwise-toolshed': [{ scope: 'user', installPath: path.join(__dirname, '..') }],
  },
}));
process.env.SIDEQUEST_CLAUDE_HOME = CLAUDE_HOME;
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
    { slug: 'codex-gpt-5-6-luna', id: 'claude-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna' },
  ],
}));
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
const WARNING = 'Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.';
const MISSING_SCOPE_WARNING = 'Planning-depth warning: declared file scope does not exist in the repo: missing/scope.js.';
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket. The executor will block at its first write, request scope, and may end before a ruling with no submission. Declare files now, or dispatch only with an explicit unscoped override.';
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
  const missingWarning = 'Anchor-path warning: executor anchor references path absent from this repo: anchor-fixtures/missing.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.';
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
    'Anchor-path warning: executor anchor references path absent from this repo: anchor-fixtures/also-missing.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
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
    'Anchor-path warning: executor anchor says requestedSymbol is in anchor-fixtures/wrong-symbol.js, but requestedSymbol does not appear in that file.',
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

test('anchor warnings ignore slashed prose and resolve package-relative files', () => {
  const packageRoot = path.join(PROJ, 'plugins', 'sidequest');
  fs.mkdirSync(path.join(packageRoot, 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(PROJ, 'selfplay-s33-long'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(packageRoot, 'scripts', '_exec-template.md'), '# template\n');
  fs.writeFileSync(path.join(packageRoot, 'src', 'hooks', 'near-turn-cap.ts'), 'export {};\n');
  fs.writeFileSync(path.join(PROJ, 'selfplay-s33-long', 'champion.pt'), 'checkpoint\n');
  const added = cliJson([
    'add', '-t', 'anchor path classification', '--complexity', '3',
    '--why', 'separate an absent source path from slashed prose and package-relative files',
    '--file', 'plugins/sidequest/src/lib',
    '--anchors', 'the cause was ref/token pairing; bb/100 and worker/chunking are prose; scripts/_exec-template.md and src/hooks/near-turn-cap.ts exist; selfplay-s33-long/champion.pt exists; missing/path.ts does not.',
  ]);

  assert.deepStrictEqual(added.warnings, [
    'Anchor-path warning: executor anchor references path absent from this repo: missing/path.ts. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
  ]);
});

test('a greenfield declared anchor warns without refusing the ticket write', () => {
  const added = cliJson([
    'add', '-t', 'greenfield anchor', '--complexity', '3',
    '--why', 'allow a future declared file while still marking the unverified anchor',
    '--file', 'greenfield-anchor/src/entry.js', '--anchors', 'createEntry is at greenfield-anchor/src/entry.js:1',
  ]);

  assert.deepStrictEqual(added.warnings, [
    'Anchor-path warning: executor anchor references path absent from this repo: greenfield-anchor/src/entry.js. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
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

  const noFiles = cliJson(['add', '-t', 'no scope declared', '--category', 'coding.normal', '--description', 'The fixture leaves file scope empty so dispatch must refuse it unless the caller makes an explicit choice.', '--changes', 'planning warning dispatch behavior']);
  assert.deepStrictEqual(noFiles.warnings, [NO_SCOPE_WARNING]);

  const refused = cliResult(['dispatch', noFiles.ticket.ref, '--unverified-transport']);
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /has no declared file scope for write work/);

  const overridden = cliResult(['dispatch', noFiles.ticket.ref, '--unverified-transport', '--allow-unscoped']);
  assert.strictEqual(overridden.status, 0, overridden.stderr + overridden.stdout);
  assert.ok(JSON.parse(overridden.stdout).warnings.includes(`Dispatch warning: ${NO_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`));

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

test('warns when a declared module has an undeclared in-package importer', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'scope-consumer');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'src', 'scope-warning.ts'), 'export function warnForScope() {}\n');
  fs.writeFileSync(path.join(project, 'src', 'dispatch.ts'), "import { warnForScope } from './scope-warning.js';\nwarnForScope();\n");

  const omitted = cliJsonAt(project, ['add', '-t', 'warn about consumers', '--category', 'coding.normal', '--file', 'src/scope-warning.ts']);
  assert.deepStrictEqual(omitted.warnings, [
    'Planning-depth warning: declared scope may omit in-package direct importer: src/dispatch.ts. Include the path if this change reaches it.',
  ]);

  const included = cliJsonAt(project, ['add', '-t', 'declare consumers', '--category', 'coding.normal', '--file', 'src/scope-warning.ts', '--file', 'src/dispatch.ts']);
  assert.deepStrictEqual(included.warnings, []);
});

test('warns for transitive consumers in the first scope warning', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'transitive-scope-consumer');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'src', 'changed.ts'), 'export const changed = true;\n');
  fs.writeFileSync(path.join(project, 'src', 'direct.ts'), "import { changed } from './changed.js';\nexport { changed };\n");
  fs.writeFileSync(path.join(project, 'src', 'second.ts'), "import { changed } from './direct.js';\nexport { changed };\n");
  fs.writeFileSync(path.join(project, 'src', 'third.ts'), "import { changed } from './second.js';\nvoid changed;\n");

  const added = cliJsonAt(project, ['add', '-t', 'warn about transitive consumers', '--category', 'coding.normal', '--file', 'src/changed.ts']);
  assert.deepStrictEqual(added.warnings, [
    'Planning-depth warning: declared scope may omit in-package 2-hop transitive consumer: src/second.ts. Include the path if this change reaches it.',
    'Planning-depth warning: declared scope may omit in-package 3-hop transitive consumer: src/third.ts. Include the path if this change reaches it.',
    'Planning-depth warning: declared scope may omit in-package direct importer: src/direct.ts. Include the path if this change reaches it.',
  ]);
});

test('summarizes large in-package consumer closures', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'large-scope-consumer');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'src', 'changed.ts'), 'export const changed = true;\n');
  for (let index = 0; index <= 12; index += 1) {
    fs.writeFileSync(path.join(project, 'src', `consumer-${index}.ts`), "import { changed } from './changed.js';\nvoid changed;\n");
  }

  const added = cliJsonAt(project, ['add', '-t', 'summarize consumers', '--category', 'coding.normal', '--file', 'src/changed.ts']);
  assert.deepStrictEqual(added.warnings, [
    'Planning-depth warning: declared scope may omit 13 in-package consumers, including 13 direct importers. Include the relevant paths if this change reaches them.',
  ]);
});

test('warns about undeclared same-basename sibling paths', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'basename-sibling');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(project, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'lib', 'plan.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(project, 'cli', 'plan.mjs'), 'export {};\n');

  const added = cliJsonAt(project, ['add', '-t', 'check sibling', '--category', 'coding.normal', '--file', 'lib/plan.mjs']);
  assert.deepStrictEqual(added.warnings, [
    'Planning-depth warning: declared path lib/plan.mjs has undeclared same-basename sibling paths: cli/plan.mjs. Check whether they consume this change before dispatch.',
  ]);
});

test('does not warn about same-basename siblings outside the package', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'package-basename-sibling');
  fs.rmSync(project, { recursive: true, force: true });
  const sidequest = path.join(project, 'plugins', 'sidequest');
  const observability = path.join(project, 'plugins', 'observability');
  fs.mkdirSync(path.join(sidequest, 'src'), { recursive: true });
  fs.mkdirSync(path.join(observability, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sidequest, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(observability, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(sidequest, 'src', 'store.ts'), 'export {};\n');
  fs.writeFileSync(path.join(observability, 'lib', 'store.ts'), 'export {};\n');

  const added = cliJsonAt(project, ['add', '-t', 'check package sibling', '--category', 'coding.normal', '--file', 'plugins/sidequest/src/store.ts']);
  assert.deepStrictEqual(added.warnings, []);
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

  const proseTail = cliResult(['add', '-t', 'prose command tail', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full. Add a test for the dispatch guard.']);
  assert.strictEqual(proseTail.status, 1);
  assert.match(proseTail.stderr + proseTail.stdout, /cannot append prose/);

  const semicolon = cliResult(['add', '-t', 'semicolon verify', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full; node --test "test/suite.test.js"']);
  assert.strictEqual(semicolon.status, 1);
  assert.match(semicolon.stderr + semicolon.stdout, /cannot use `;` command chaining/);

  const compoundMissingGlob = cliJson(['add', '-t', 'compound missing glob', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full && node --test "test/missing.test.js"']);
  assert.match(compoundMissingGlob.warnings.join('\n'), /matches no files/);
  assert.match(store.dispatchVerifyCommandError(compoundMissingGlob.ticket, PROJ), /matches no files/);

  const compound = cliJson(['add', '-t', 'working compound verify', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full && node --test "test/suite.test.js"']);
  assert.strictEqual(store.dispatchVerifyCommandError(compound.ticket, PROJ), null);

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

  cliJson(['claim', correct.ticket.ref, '--by', 'live-verify-worker', '--direct', '--reason', 'The live verify fixture needs a direct local claim.']);
  const rejectedLiveUpdate = cliResult(['update', correct.ticket.ref, '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.strictEqual(rejectedLiveUpdate.status, 1);
  assert.match(rejectedLiveUpdate.stderr + rejectedLiveUpdate.stdout, /dispatch: verify command cannot run/);
  const manualLiveUpdate = cliJson(['update', correct.ticket.ref, '--verify', 'manual: Checked the test plan while the ticket was claimed.']);
  assert.strictEqual(manualLiveUpdate.ticket.executorVerify, 'manual: Checked the test plan while the ticket was claimed.');

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

test('MCP add returns each planning warning only once per ticket and session', () => {
  const add = mcpTicketTools.find((tool: any) => tool.name === 'add');
  assert.ok(add);
  const originalSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'planning-warning-mcp-session';
  try {
    const first = add.handler({
      project: PROJ,
      title: 'MCP warning deduplication',
      category: 'coding.normal',
      description: 'The observed threshold is 75% and needs a change before dispatch.',
    });
    assert.equal(first.warnings.length, 2);
    const update = mcpTicketTools.find((tool: any) => tool.name === 'update');
    assert.ok(update);
    const repeated = update.handler({ project: PROJ, ref: first.ref, title: 'MCP warning deduplication, repeated' });
    assert.equal(repeated.warnings, undefined);
  } finally {
    if (originalSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = originalSessionId;
  }
});

test('warning presentation deduplicates by ticket and session while preserving new warnings', () => {
  const warnings = [
    'Planning-depth warning: routine advisory one.',
    'Planning-depth warning: declared source scope under ./src omits tracked build output lib.',
    'Planning-depth warning: routine advisory two.',
    'Planning-depth warning: verify command cannot run.',
    'Planning-depth warning: routine advisory three.',
  ];
  const ticket = { ref: 'SQ-warning-presentation' };
  const first = store.presentWarnings(ticket, warnings, 'warning-session');
  assert.deepStrictEqual(first, [
    'Planning-depth warning: verify command cannot run.',
    'Planning-depth warning: declared source scope under ./src omits tracked build output lib.',
    'Warning summary: 3 lower-priority warnings suppressed for this call.',
  ]);
  assert.deepStrictEqual(store.presentWarnings(ticket, warnings, 'warning-session'), [
    'Planning-depth warning: routine advisory one.',
    'Planning-depth warning: routine advisory two.',
    'Planning-depth warning: routine advisory three.',
  ]);
  assert.deepStrictEqual(store.presentWarnings(ticket, warnings, 'warning-session'), []);
  assert.deepStrictEqual(store.presentWarnings({ ref: 'SQ-other-ticket' }, warnings, 'warning-session'), first);
  assert.deepStrictEqual(store.presentWarnings(ticket, ['Planning-depth warning: newly detected condition.'], 'warning-session'), [
    'Planning-depth warning: newly detected condition.',
  ]);
});

export {};
