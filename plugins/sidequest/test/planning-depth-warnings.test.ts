import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import { planningDepthWarningsFixtureParent } from './_fixture-provenance.js';
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
const { tools: mcpReadTools } = require('../lib/mcp-read');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(planningDepthWarningsFixtureParent, 'board');
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
  updatedAt: new Date().toISOString(),
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
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket, and this board has no autoApproveScope policy that can grant the first request. Dispatch will refuse unless you declare files or explicitly allow an unscoped run.';
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

function cliResultAt(project: any, args: any[]) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: project });
  return spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
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

test('normalizes declared directory patterns before checking scope existence', () => {
  fs.mkdirSync(path.join(PROJ, 'scope-fixtures', 'existing'), { recursive: true });
  const added = cliJson([
    'add', '-t', 'directory pattern scope', '--complexity', '3',
    '--why', 'declare every file in an existing directory without statting the glob literally',
    '--file', 'scope-fixtures/existing/**',
  ]);

  assert.deepStrictEqual(added.warnings, []);
});

test('explicit readonly overrides suppress category write-intent warnings', () => {
  fs.mkdirSync(path.join(PROJ, 'readonly-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'readonly-fixtures', 'evidence.md'), 'evidence\n');
  const added = cliJson([
    'add', '-t', 'readonly scoped evidence', '--category', 'source-lookup', '--readonly', 'true',
    '--description', 'Record the repository evidence without changing it.',
    '--file', 'readonly-fixtures/evidence.md',
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

test('anchor parsing excludes sentence-ending punctuation from existing and missing paths', () => {
  fs.mkdirSync(path.join(PROJ, 'anchor-punctuation'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'anchor-punctuation', 'present.ts'), 'export const present = true;\n');
  const existing = cliJson([
    'add', '-t', 'existing punctuated anchor', '--complexity', '3',
    '--why', 'allow an anchor path at the end of a normal prose sentence',
    '--file', 'anchor-punctuation/present.ts', '--anchors', 'Inspect anchor-punctuation/present.ts.',
  ]);
  assert.deepStrictEqual(existing.warnings, []);

  const missing = cliJson([
    'add', '-t', 'missing punctuated anchor', '--complexity', '3',
    '--why', 'report a missing repo-relative path even when it ends a prose sentence',
    '--file', 'anchor-punctuation/present.ts', '--anchors', 'Create greenfield-anchor/src/entry.ts.',
  ]);
  assert.deepStrictEqual(missing.warnings, [
    'Anchor-path warning: executor anchor references path absent from this repo: greenfield-anchor/src/entry.ts. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
  ]);
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

test('submission-review anchors resolve against their explicit pinned ref or commit', () => {
  const project = path.join(planningDepthWarningsFixtureParent, 'pinned-anchor');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'test'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(project, 'test', 'context-projection-benchmark.test.ts'), 'export {};\n');
  assert.strictEqual(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'seed pinned review'], { cwd: project, encoding: 'utf8' }).status, 0);
  const pinned = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(spawnSync('git', ['update-ref', 'refs/sidequest/SQ-1565', pinned], { cwd: project, encoding: 'utf8' }).status, 0);
  fs.rmSync(path.join(project, 'test', 'context-projection-benchmark.test.ts'));

  const added = cliJsonAt(project, [
    'add', '-t', 'review a submitted context benchmark', '--category', 'source-lookup', '--readonly', 'true', '--file', 'README.md',
    '--anchors', `Review test/context-projection-benchmark.test.ts from refs/sidequest/SQ-1565 at commit ${pinned}.`,
  ]);
  assert.deepStrictEqual(added.warnings, []);

  const absent = cliJsonAt(project, [
    'add', '-t', 'review an absent submitted path', '--category', 'source-lookup', '--readonly', 'true', '--file', 'README.md',
    '--anchors', `Review test/missing-benchmark.test.ts from refs/sidequest/SQ-1565 at commit ${pinned}.`,
  ]);
  assert.deepStrictEqual(absent.warnings, [
    'Anchor-path warning: executor anchor references path absent from this repo or its explicit pinned submission: test/missing-benchmark.test.ts. This is allowed for greenfield work; confirm the executor creates it before relying on the anchor.',
  ]);
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

test('add refuses declared output outside the repo worktree', () => {
  const scope = path.join(path.dirname(PROJ), 'external-audition.html').replace(/\\/g, '/');
  const result = cliResult([
    'add', '-t', 'external output', '--complexity', '3',
    '--why', 'exercise refusal coverage for output outside the repository worktree',
    '--file', scope,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /declared file scope contains paths outside the repo worktree/);
  assert.match(result.stderr, /classify as non-repo\/artifact work/);
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

test('claim cannot reach external-output guidance after declaration refusal', () => {
  const scope = path.join(path.dirname(PROJ), 'external-dispatch-audition.html').replace(/\\/g, '/');
  const result = cliResult([
    'add', '-t', 'claim external output', '--complexity', '3',
    '--why', 'claim a ticket with external output for declaration refusal coverage',
    '--file', scope,
    '--label', 'direct-ok',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /declared file scope contains paths outside the repo worktree/);
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

test('add warns for a write-scope ticket with no declared files, and dispatch refuses without a rescuing policy', () => {
  const scopedFile = path.join(PROJ, 'lib', 'existing.js');
  fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
  fs.writeFileSync(scopedFile, 'existing\n');

  const noFiles = cliJson(['add', '-t', 'no scope declared', '--category', 'coding.normal', '--description', 'The fixture leaves file scope and change contracts empty, so dispatch must refuse unless a board policy can grant the first scope request.']);
  assert.deepStrictEqual(noFiles.warnings, [NO_SCOPE_WARNING]);

  const refused = cliResult(['dispatch', noFiles.ticket.ref, '--unverified-transport']);
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /has no declared file scope for write work/);

  const overridden = cliResult(['dispatch', noFiles.ticket.ref, '--unverified-transport', '--allow-unscoped']);
  assert.strictEqual(overridden.status, 0, overridden.stderr + overridden.stdout);
  assert.ok(JSON.parse(overridden.stdout).warnings.includes(`Dispatch warning: ${NO_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`));

  const policyProject = path.join(planningDepthWarningsFixtureParent, 'policy-board');
  fs.mkdirSync(policyProject, { recursive: true });
  const policyConfig = cliJsonAt(policyProject, ['board-config', '--auto-approve-scope', 'generated/**']);
  assert.deepStrictEqual(policyConfig.autoApproveScope, ['generated/**']);
  const policyTicket = cliJsonAt(policyProject, ['add', '-t', 'scope can be rescued', '--category', 'coding.normal', '--description', 'The board policy can grant the executor first scope request even though this ticket declares no files.']);
  assert.doesNotMatch(policyTicket.warnings.join('\n'), /no file scope declared/);
  const policyDispatch = cliResultAt(policyProject, ['dispatch', policyTicket.ticket.ref, '--unverified-transport']);
  assert.strictEqual(policyDispatch.status, 0, policyDispatch.stderr + policyDispatch.stdout);
  const policyDispatchPayload = JSON.parse(policyDispatch.stdout);
  assert.doesNotMatch(policyDispatchPayload.warnings.join('\n'), /no file scope declared/);
  // An isolated dispatch binds its claiming runtime by session id, and the CLI
  // falls back to CLAUDE_CODE_SESSION_ID when --session is absent. A developer
  // machine inside Claude Code exports one and CI does not, so leaving it
  // implicit passes locally and refuses `unbound_dispatch` on CI.
  const policyClaim = cliJsonAt(policyProject, ['claim', policyTicket.ticket.ref, '--by', 'policy-worker', '--session', 'policy-executor-session', '--token', policyDispatchPayload.token, '--executor', policyDispatchPayload.agent]);
  assert.equal(policyClaim.ok, true, policyClaim.reason);
  const policyScope = cliJsonAt(policyProject, ['scope-request', policyTicket.ticket.ref, '--by', 'policy-worker', '--file', 'generated/output.js']);
  assert.deepStrictEqual(policyScope.approved, ['generated/output.js']);
  assert.deepStrictEqual(policyScope.refused, []);

  const withFiles = cliJson(['add', '-t', 'scope declared', '--category', 'coding.normal', '--description', 'Add a thing.', '--file', 'lib/existing.js']);
  assert.deepStrictEqual(withFiles.warnings, []);

  const readonly = cliJson(['add', '-t', 'readonly ticket', '--category', 'source-lookup', '--description', 'Look something up.']);
  assert.deepStrictEqual(readonly.warnings, []);
});

test('warns when tracked package build output is omitted from source scope', () => {
  const project = path.join(planningDepthWarningsFixtureParent, 'tracked-output');
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
  const project = path.join(planningDepthWarningsFixtureParent, 'scope-consumer');
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
  const project = path.join(planningDepthWarningsFixtureParent, 'transitive-scope-consumer');
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
  const project = path.join(planningDepthWarningsFixtureParent, 'large-scope-consumer');
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
  const project = path.join(planningDepthWarningsFixtureParent, 'basename-sibling');
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

test('folds sibling-directory warnings while retaining direct importers and full paths', () => {
  const project = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'many-basename-siblings');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src', 'dojo', '00'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'src', 'dojo', '00', 'drill.ts'), 'export const drill = true;\n');
  fs.writeFileSync(path.join(project, 'src', 'dojo', '00', 'drill.js'), 'export const drill = true;\n');
  fs.writeFileSync(path.join(project, 'src', 'direct.ts'), "import { drill } from './dojo/00/drill.ts';\nvoid drill;\n");
  for (let index = 1; index <= 13; index += 1) {
    const directory = path.join(project, 'src', 'dojo', String(index).padStart(2, '0'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'drill.ts'), 'export const drill = true;\n');
  }

  const add = mcpTicketTools.find((tool: any) => tool.name === 'add');
  const contextPage = mcpReadTools.find((tool: any) => tool.name === 'context_page');
  assert.ok(add);
  assert.ok(contextPage);
  const added = add.handler({
    project,
    title: 'fold sibling paths',
    category: 'coding.normal',
    files: ['src/dojo/00/drill.ts'],
  });

  assert.ok(added.warnings.some((warning: string) => warning.includes('direct importer: src/direct.ts')));
  assert.ok(added.warnings.some((warning: string) => warning.includes('13 undeclared same-basename sibling paths in separate directories')));
  assert.ok(added.warnings.some((warning: string) => warning.includes('src/dojo/00/drill.js')));
  assert.ok(!added.warnings.some((warning: string) => warning.includes('src/dojo/01/drill.ts')));
  assert.deepStrictEqual({ groups: added.sameBasenameSiblingDetails.groups, paths: added.sameBasenameSiblingDetails.paths }, { groups: 1, paths: 14 });

  const details = contextPage.handler(added.sameBasenameSiblingDetails.retrieval.arguments);
  assert.deepStrictEqual(details.rows, [{
    sourceRelative: 'src/dojo/00/drill.ts',
    siblingPaths: ['src/dojo/00/drill.js', ...Array.from({ length: 13 }, (_, index) => `src/dojo/${String(index + 1).padStart(2, '0')}/drill.ts`)],
  }]);
});

test('does not warn about same-basename siblings outside the package', () => {
  const project = path.join(planningDepthWarningsFixtureParent, 'package-basename-sibling');
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
  const project = path.join(planningDepthWarningsFixtureParent, 'bundled-hook-output');
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

test('readonly tickets skip build-output and consumer write-scope warnings on add and dispatch', () => {
  const project = path.join(planningDepthWarningsFixtureParent, 'readonly-output');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(project, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  fs.writeFileSync(path.join(project, 'scripts', 'build.mjs'), [
    "export const nonBundledBuildDirectories = ['lib'];",
    'export const bundledBuildOutputs = [{',
    "  sourceDirectory: 'src/hooks',",
    "  outputDirectory: 'hooks',",
    "  sourceExtension: '.ts',",
    "  outputExtension: '.js',",
    '}];',
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'src', 'lib', 'store.ts'), 'export const readOnlyReview = true;\n');
  fs.writeFileSync(path.join(project, 'src', 'lib', 'consumer.ts'), "import { readOnlyReview } from './store.js';\nvoid readOnlyReview;\n");
  fs.writeFileSync(path.join(project, 'src', 'hooks', 'subagent-stop.ts'), 'export {};\n');
  fs.writeFileSync(path.join(project, 'lib', 'store.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(project, 'hooks', 'subagent-stop.js'), 'module.exports = {};\n');
  assert.strictEqual(spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: project, encoding: 'utf8' }).status, 0);

  const writable = cliJsonAt(project, [
    'add', '-t', 'writable source change', '--category', 'coding.normal',
    '--file', 'src/lib/store.ts', '--file', 'src/hooks/subagent-stop.ts',
  ]);
  assert.ok(writable.warnings.some((warning: string) => warning.includes('tracked build output lib')));
  assert.ok(writable.warnings.some((warning: string) => warning.includes('tracked build output hooks')));
  assert.ok(writable.warnings.some((warning: string) => warning.includes('direct importer: src/lib/consumer.ts')));

  const readonly = cliJsonAt(project, [
    'add', '-t', 'readonly source review', '--category', 'source-lookup', '--readonly', 'true',
    '--description', 'Review the source and generated outputs for a planning audit without changing either file or rebuilding package artifacts.',
    '--verify', 'manual: Reviewed the pinned source and generated output relationship.',
    '--file', 'src/lib/store.ts', '--file', 'src/hooks/subagent-stop.ts',
  ]);
  assert.deepStrictEqual(readonly.warnings, []);
  const dispatched = cliResultAt(project, ['dispatch', readonly.ticket.ref, '--unverified-transport']);
  assert.strictEqual(dispatched.status, 0, dispatched.stderr + dispatched.stdout);
  const dispatchWarnings = JSON.parse(dispatched.stdout).warnings;
  assert.ok(dispatchWarnings.includes('readonly override active: this ticket closes with done + comment despite its category default.'));
  assert.ok(!dispatchWarnings.some((warning: string) => /tracked build output|direct importer/.test(warning)));
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

test('rejects unrunnable npm verifies when tickets are added or updated', () => {
  const packageDir = path.join(PROJ, 'plugins', 'package-suite');
  const bareDir = path.join(PROJ, 'plugins', 'bare-suite');
  fs.mkdirSync(path.join(packageDir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(bareDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node --test "test/*.test.js"' } }));
  fs.writeFileSync(path.join(packageDir, 'test', 'suite.test.js'), '');
  fs.writeFileSync(path.join(bareDir, 'test', 'suite.test.js'), '');

  const npmTest = cliResult(['add', '-t', 'missing npm manifest', '--category', 'coding.normal', '--description', 'Verify the fixture command before dispatching so this description satisfies the executor briefing requirement.', '--file', 'plugins/bare-suite/test/suite.test.js', '--verify', 'cd plugins/bare-suite && npm test']);
  assert.strictEqual(npmTest.status, 1);
  assert.match(npmTest.stderr + npmTest.stdout, /npm test.*package\.json/);
  assert.match(npmTest.stderr + npmTest.stdout, /acceptance criteria in a comment/);

  const correct = cliJson(['add', '-t', 'working verify', '--category', 'coding.normal', '--description', 'Verify the fixture command before dispatching so this description satisfies the executor briefing requirement.', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'cd plugins/package-suite && npm run test:full']);
  assert.deepStrictEqual(correct.warnings, []);
  assert.strictEqual(store.dispatchVerifyCommandError(correct.ticket, PROJ), null);

  const missingPrefixedTest = cliResult(['add', '-t', 'missing prefixed test script', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'npm --prefix plugins/package-suite test']);
  assert.strictEqual(missingPrefixedTest.status, 1);
  assert.match(missingPrefixedTest.stderr + missingPrefixedTest.stdout, /npm --prefix plugins\/package-suite test.*`test` script/);

  const missingPrefixedRun = cliResult(['add', '-t', 'missing prefixed run script', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'npm --prefix plugins/package-suite run missing']);
  assert.strictEqual(missingPrefixedRun.status, 1);
  assert.match(missingPrefixedRun.stderr + missingPrefixedRun.stdout, /npm --prefix plugins\/package-suite run missing.*`missing` script/);

  const correctPrefixedRun = cliJson(['add', '-t', 'working prefixed verify', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'npm --prefix plugins/package-suite run test:full']);
  assert.deepStrictEqual(correctPrefixedRun.warnings, []);
  assert.strictEqual(store.dispatchVerifyCommandError(correctPrefixedRun.ticket, PROJ), null);

  const missingScript = cliResult(['update', correct.ticket.ref, '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.strictEqual(missingScript.status, 1);
  assert.match(missingScript.stderr + missingScript.stdout, /`missing` script/);
  assert.match(missingScript.stderr + missingScript.stdout, /acceptance criteria in a comment/);

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

  cliJson(['claim', correct.ticket.ref, '--by', 'live-verify-worker', '--direct', '--reason', 'The live verify fixture needs a direct local claim.']);
  const rejectedLiveUpdate = cliResult(['update', correct.ticket.ref, '--verify', 'cd plugins/package-suite && npm run missing']);
  assert.strictEqual(rejectedLiveUpdate.status, 1);
  assert.match(rejectedLiveUpdate.stderr + rejectedLiveUpdate.stdout, /dispatch: verify command cannot run/);
  const manualLiveUpdate = cliJson(['update', correct.ticket.ref, '--verify', 'manual: Checked the test plan while the ticket was claimed.']);
  assert.strictEqual(manualLiveUpdate.ticket.executorVerify, 'manual: Checked the test plan while the ticket was claimed.');

  const correctDispatch = cliResult(['dispatch', correct.ticket.ref]);
  assert.strictEqual(correctDispatch.status, 1);
  assert.doesNotMatch(correctDispatch.stderr + correctDispatch.stdout, /dispatch: verify command cannot run/);

  const manual = cliJson(['add', '-t', 'manual verify survives dispatch', '--category', 'coding.normal', '--file', 'plugins/package-suite/test/suite.test.js', '--verify', 'manual: Checked the test plan.']);
  assert.deepStrictEqual(manual.warnings, []);
  assert.strictEqual(store.dispatchVerifyCommandError(manual.ticket, PROJ), null);
});

test('defers greenfield npm package verification only for declared package manifests', () => {
  const prefix = cliJson([
    'add', '-t', 'greenfield prefixed verify', '--category', 'coding.normal',
    '--file', 'plugins/greenfield-prefix/package.json', '--file', 'plugins/greenfield-prefix/test/suite.test.js',
    '--verify', 'npm --prefix plugins/greenfield-prefix run test:files',
  ]);
  assert.match(prefix.warnings.join('\n'), /deferred verify preflight.*plugins\/greenfield-prefix\/package\.json/);
  assert.strictEqual(store.dispatchVerifyCommandError(prefix.ticket, PROJ), null);

  const changedDirectory = cliJson([
    'add', '-t', 'greenfield directory verify', '--category', 'coding.normal',
    '--file', 'plugins/greenfield-directory/package.json', '--file', 'plugins/greenfield-directory/test/suite.test.js',
    '--verify', 'cd plugins/greenfield-directory && npm run test:files',
  ]);
  assert.match(changedDirectory.warnings.join('\n'), /deferred verify preflight.*plugins\/greenfield-directory\/package\.json/);
  assert.strictEqual(store.dispatchVerifyCommandError(changedDirectory.ticket, PROJ), null);

  const undeclared = cliJson([
    'add', '-t', 'undeclared greenfield verify', '--category', 'coding.normal',
    '--file', 'plugins/another-package/package.json',
    '--verify', 'npm --prefix plugins/undeclared-package run test:files',
  ]);
  assert.match(store.dispatchVerifyCommandError(undeclared.ticket, PROJ), /declared greenfield package scope/);

  const directoryScope = cliJson([
    'add', '-t', 'directory-only greenfield verify', '--category', 'coding.normal',
    '--file', 'plugins/directory-only',
    '--verify', 'cd plugins/directory-only && npm run test:files',
  ]);
  assert.match(store.dispatchVerifyCommandError(directoryScope.ticket, PROJ), /declared greenfield package scope/);

  const typo = cliJson([
    'add', '-t', 'mistyped greenfield verify', '--category', 'coding.normal',
    '--file', 'plugins/greenfield-typo/package.json',
    '--verify', 'npm --prefix plugins/greenfield-typ run test:files',
  ]);
  assert.match(store.dispatchVerifyCommandError(typo.ticket, PROJ), /declared greenfield package scope/);

  const outsideRepository = cliJson([
    'add', '-t', 'outside greenfield verify', '--category', 'coding.normal',
    '--file', 'plugins/greenfield-outside/package.json',
    '--verify', 'npm --prefix ../greenfield-outside run test:files',
  ]);
  assert.match(store.dispatchVerifyCommandError(outsideRepository.ticket, PROJ), /outside this repo/);
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

// SQ-1962. Four dispatches in a row were told their existing test files were absent, because every
// path-shaped token was resolved against the repository root no matter what base the command established.
// A git revision range was reported as a missing file for the same reason. The point of these rows is that
// the true positive survives: the scanner has to keep naming a genuinely missing path, or the cheap fix is
// to stop scanning.
function verifyPathWarningsFor(root: string, verify: string): string[] {
  const { slug } = store.ensureProject(root, 'verify path base');
  const ticket = store.createTicket(slug, { title: `verify path ${verify}`, executorVerify: verify });
  return store.dispatchUncertaintyWarnings(ticket, slug)
    .filter((warning: string) => warning.includes('references paths absent'));
}

test('SQ-1962: verify path arguments resolve against the base their command establishes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-path-base-'));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, windowsHide: true });
  for (const [directory, testFile] of [['pkg', 'exists.test.ts'], ['other', 'only-here.test.ts']]) {
    fs.mkdirSync(path.join(root, directory, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify({ name: directory, scripts: { 'test:files': 'node --test' } }));
    fs.writeFileSync(path.join(root, directory, 'test', testFile), 'export {};\n');
  }

  assert.deepStrictEqual(verifyPathWarningsFor(root, 'npm --prefix pkg run test:files -- test/exists.test.ts'), []);
  assert.deepStrictEqual(verifyPathWarningsFor(root, 'cd pkg && npm run test:files -- test/exists.test.ts'), []);
  assert.deepStrictEqual(verifyPathWarningsFor(root, 'git diff 1af30b7f..fa999563 --name-only'), []);
  assert.deepStrictEqual(
    verifyPathWarningsFor(root, 'cd pkg && npm run test:files -- test/exists.test.ts && cd ../other && npm run test:files -- test/only-here.test.ts'),
    [],
    'a cd partway through moves the base for everything after it',
  );

  const missing = 'This is allowed for greenfield work; confirm the executor creates them before verifying.';
  assert.deepStrictEqual(
    verifyPathWarningsFor(root, 'npm --prefix pkg run test:files -- test/missing.test.ts'),
    [`Dispatch warning: recorded verify references paths absent from this repo: pkg/test/missing.test.ts. ${missing}`],
    'a genuinely missing path still warns, named where the command would look for it',
  );
  assert.deepStrictEqual(
    verifyPathWarningsFor(root, 'cd pkg && npm run test:files -- test/exists.test.ts && cd ../other && npm run test:files -- test/exists.test.ts'),
    [`Dispatch warning: recorded verify references paths absent from this repo: other/test/exists.test.ts. ${missing}`],
    'the same relative path is absent or present depending on which package the command reached',
  );
});

test('SQ-2200: verify preflight looks up each npm script in the package its own segment reached', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-preflight-base-'));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, windowsHide: true });
  fs.mkdirSync(path.join(root, 'first'), { recursive: true });
  fs.mkdirSync(path.join(root, 'second'), { recursive: true });
  fs.writeFileSync(path.join(root, 'first', 'package.json'), JSON.stringify({ name: 'first', scripts: { build: 'node -e 0' } }));
  fs.writeFileSync(path.join(root, 'second', 'package.json'), JSON.stringify({ name: 'second', scripts: { 'build:check': 'node -e 0' } }));
  const { slug } = store.ensureProject(root, 'verify preflight base');
  const file = (verify: string) => store.createTicket(slug, { title: `preflight ${verify}`, executorVerify: verify });

  assert.ok(file('cd first && npm run build'), 'a single cd is unchanged');
  assert.ok(
    file('cd first && npm run build && cd ../second && npm run build:check'),
    'the second package owns the script that follows the cd into it',
  );
  assert.throws(
    () => file('cd first && npm run build && cd ../second && npm run build'),
    /`npm run build` requires a `build` script in second\/package\.json/,
    'a script missing from the package the command reached still refuses, and names that package',
  );
  assert.throws(
    () => file('cd first && npm run missing-script'),
    /`npm run missing-script` requires a `missing-script` script in first\/package\.json/,
  );
});

export {};
