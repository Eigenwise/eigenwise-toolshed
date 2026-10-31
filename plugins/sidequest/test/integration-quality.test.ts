import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { QualityInput } from '../src/lib/integration-quality.js';

const runIntegrationQuality: typeof import('../src/lib/integration-quality.js').runIntegrationQuality = require('../lib/integration-quality.js').runIntegrationQuality;

function qualityFixture(directory: string, complexity: number, covered: boolean): QualityInput {
  const gate = path.join(directory, 'gate');
  fs.mkdirSync(path.join(gate, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'quality-gate@eigenwise-toolshed': [{ scope: 'project', projectPath: directory, installPath: gate }] },
  }));
  const measured = { relativePath: 'source.js', line: 1, name: 'candidateBody', complexity, classification: 'new', branches: [] };
  const row = covered ? { ...measured, coverage: 1, crap: complexity } : { ...measured, unverified: 'no authentic executed source map' };
  const report = { changedMetrics: [row], failures: [], unverified: covered ? [] : [row] };
  fs.writeFileSync(path.join(gate, 'bin', 'quality-gate.js'), `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
  fs.writeFileSync(path.join(directory, 'source.js'), 'function candidateBody() { return true; }');
  return { project: directory, registeredProject: directory, directory: path.join(directory, 'board-evidence'), base: 'dispatch-baseline', changedPaths: ['source.js'], timeoutMilliseconds: 20_000 };
}

function withQualityFixture(context: { after(callback: () => void): void }, complexity: number, covered: boolean): QualityInput {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-native-quality-'));
  const previousHome = process.env.SIDEQUEST_CLAUDE_HOME;
  context.after(() => {
    if (previousHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const input = qualityFixture(directory, complexity, covered);
  process.env.SIDEQUEST_CLAUDE_HOME = path.join(directory, 'claude');
  return input;
}

function initializeNativeProject(input: QualityInput): void {
  for (const argumentsList of [['init', '-q'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']]) {
    const result = spawnSync('git', argumentsList, { cwd: input.project, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  }
  input.base = 'HEAD';
}

function nativeMappedPlugin(input: QualityInput): void {
  const plugin = path.join(input.project, 'plugins/neutral');
  fs.mkdirSync(path.join(plugin, 'src'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'src/subject.ts'), 'export function subject(): number {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ scripts: { 'coverage:lcov': 'node coverage.cjs' } }));
  fs.writeFileSync(path.join(plugin, 'coverage.cjs'), `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.QUALITY_GATE_COVERAGE_DIR, 'lcov.info'), 'SF:lib/subject.js\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nend_of_record\\n');`);
  initializeNativeProject(input);
  const source = 'export function subject(): number {\n  return 2;\n}\n';
  fs.writeFileSync(path.join(plugin, 'src/subject.ts'), source);
  fs.writeFileSync(path.join(plugin, 'lib/subject.js'), 'function subject() {\n  return 2;\n}\n//# sourceMappingURL=subject.js.map\n');
  fs.writeFileSync(path.join(plugin, 'lib/subject.js.map'), JSON.stringify({ version: 3, sources: ['../src/subject.ts'], sourcesContent: [source], names: [], mappings: 'AAAA;AACA;AACA' }));
  input.changedPaths = ['plugins/neutral/src/subject.ts', 'plugins/neutral/lib/subject.js'];
  const gate = path.resolve(__dirname, '../../quality-gate');
  fs.writeFileSync(path.join(input.project, 'claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'quality-gate@eigenwise-toolshed': [{ scope: 'project', projectPath: input.project, installPath: gate }] } }));
}

test('native generated LCOV integration measures TypeScript and reports the missing-map refusal', (context) => {
  const input = withQualityFixture(context, 1, true);
  nativeMappedPlugin(input);
  const verify = () => ({ kind: 'command' as const, status: 'passed' as const, evidence: 'fixture verifier' });
  const measured = runIntegrationQuality([input], verify);
  assert.equal(measured.quality[0]!.measurementPath, 'crap', JSON.stringify(measured));
  assert.equal(measured.quality[0]!.status, 'measured', JSON.stringify(measured));
  assert.equal(measured.quality[0]!.worstBody!.name, 'subject');
  assert.equal(measured.quality[0]!.worstBody!.crap, 1);
  assert.equal(measured.quality[0]!.sourceMapTranslations!.length, 1);
  assert.deepEqual(measured.quality[0]!.sourceMapRefusals, []);
  fs.rmSync(path.join(input.project, 'plugins/neutral/lib/subject.js.map'));
  const missing = runIntegrationQuality([input], verify);
  assert.equal(missing.quality[0]!.status, 'unverified', JSON.stringify(missing));
  assert.match(JSON.stringify(missing.quality[0]!.sourceMapRefusals), /source map/i);
  assert.match(missing.quality[0]!.unverified[0]!.unverified!, /LCOV/);
});

test('native quality orchestration selects configured LCOV command and retains translations', (context) => {
  const input = withQualityFixture(context, 2, true);
  fs.mkdirSync(path.join(input.project, '.claude/quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(input.project, '.claude/quality-gate/crap.json'), JSON.stringify({ coverageCommand: 'node capture.js', lcovBase: 'plugin' }));
  const translations = [{ generated: 'plugin/lib/subject.js', sources: ['plugin/src/subject.ts'] }];
  const row = { name: 'candidateBody', complexity: 2, crap: 2, classification: 'new' };
  const report = { changedMetrics: [row], failures: [], unverified: [], sourceMapTranslations: translations };
  fs.writeFileSync(path.join(input.project, 'gate/bin/quality-gate.js'), `
const assert = require('node:assert/strict');
assert.equal(process.argv[2], 'crap');
assert.equal(process.argv[process.argv.indexOf('--coverage-command') + 1], 'node capture.js');
assert.equal(process.argv[process.argv.indexOf('--lcov-base') + 1], 'plugin');
assert.equal(process.argv[process.argv.indexOf('--source') + 1], 'source.js');
process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
  const result = runIntegrationQuality([input], () => ({ kind: 'command', status: 'passed', evidence: 'fixture verifier' }));
  assert.equal(result.quality[0]!.measurementPath, 'crap');
  assert.deepEqual(result.quality[0]!.sourceMapTranslations, translations);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.quality[0]!.receipt!, 'utf8')).sourceMapTranslations, translations);
});

test('native quality refuses a zero-row report when AST inventory finds changed bodies', (context) => {
  const input = withQualityFixture(context, 2, true);
  const inventory = { changedMetrics: [{ name: 'candidateBody', complexity: 2, classification: 'new' }], failures: [], unverified: [] };
  const empty = { changedMetrics: [], failures: [], unverified: [], nothingToScoreReason: 'coverage path selected no bodies' };
  fs.writeFileSync(path.join(input.project, 'gate/bin/quality-gate.js'), `process.stdout.write(JSON.stringify(process.argv.includes('--cc-only') ? ${JSON.stringify(inventory)} : ${JSON.stringify(empty)}));`);
  const result = runIntegrationQuality([input], () => ({ kind: 'command', status: 'passed', evidence: 'fixture verifier' }));
  assert.equal(result.status, 'failed_check');
  assert.equal(result.quality[0]!.measurementSummary, '0 of 1 changed bodies measured: coverage path selected no bodies');
  assert.equal(result.quality[0]!.unverified[0]!.complexity, 2);
});

test('native quality orchestration refuses the owner-reported CC floor even without coverage', (context) => {
  const input = withQualityFixture(context, 7, false);
  const result = runIntegrationQuality([input], (environment) => {
    assert.match(environment.NODE_OPTIONS!, /--import=file:/);
    assert.equal(environment.QUALITY_GATE_V8_CAPTURE, path.join(input.directory, 'coverage'));
    assert.deepEqual(fs.readdirSync(environment.QUALITY_GATE_V8_CAPTURE!), []);
    return { kind: 'command', status: 'passed', evidence: 'fixture verifier' };
  });
  assert.equal(result.status, 'failed_check');
  assert.match(result.evidence, /candidateBody cc=7/);
  assert.equal(result.quality[0]!.enforced, 1);
  assert.equal(result.quality[0]!.unverified.length, 1);
  assert.ok(fs.existsSync(result.quality[0]!.receipt!));
  assert.equal(fs.existsSync(path.join(input.project, '.claude', 'quality-gate', 'receipts')), false);
});

test('native quality orchestration records measured rows and preserves native branch evidence', (context) => {
  const input = withQualityFixture(context, 3, true);
  const result = runIntegrationQuality([input], () => ({ kind: 'command', status: 'passed', evidence: 'fixture verifier' }));
  assert.equal(result.status, 'passed');
  assert.equal(result.quality[0]!.status, 'measured');
  assert.equal(result.quality[0]!.worstBody!.crap, 3);
  assert.equal(result.quality[0]!.baseline, 'dispatch-baseline');
  assert.deepEqual(result.quality[0]!.branches, [{ file: 'source.js', name: 'candidateBody', conditions: [] }]);
});

test('native quality orchestration leaves unmapped rows unverified without failing a green verifier', (context) => {
  const input = withQualityFixture(context, 3, false);
  const result = runIntegrationQuality([input], () => ({ kind: 'command', status: 'passed', evidence: 'fixture verifier' }));
  assert.equal(result.status, 'passed');
  assert.equal(result.quality[0]!.status, 'unverified');
  assert.match(result.quality[0]!.unverified[0]!.unverified!, /authentic executed source map/);
});

test('native quality orchestration preserves capture-slot environment and verifies once before measurement', (context) => {
  const input = withQualityFixture(context, 3, true);
  const slotEnvironment = { ...process.env, SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: '0', NODE_OPTIONS: '--enable-source-maps' };
  let verificationCount = 0;
  const result = runIntegrationQuality([input], (environment) => {
    verificationCount += 1;
    assert.equal(environment.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT, '0');
    assert.match(environment.NODE_OPTIONS!, /^--enable-source-maps --import=file:/);
    assert.equal(environment.QUALITY_GATE_V8_CAPTURE, path.join(input.directory, 'coverage'));
    assert.equal(fs.existsSync(path.join(input.directory, 'measure.json')), false);
    return { kind: 'command', status: 'passed', evidence: 'fixture verifier' };
  }, slotEnvironment);
  assert.equal(verificationCount, 1);
  assert.equal(slotEnvironment.NODE_OPTIONS, '--enable-source-maps');
  assert.equal(result.status, 'passed');
  assert.equal(result.quality[0]!.status, 'measured');
  assert.ok(fs.existsSync(path.join(input.directory, 'measure.json')));
});

test('native quality orchestration records none when no gate is registered for the project', (context) => {
  const input = withQualityFixture(context, 3, true);
  input.registeredProject = path.join(input.project, 'unregistered');
  const result = runIntegrationQuality([input], (environment) => {
    assert.equal(environment, process.env);
    return { kind: 'command', status: 'passed', evidence: 'fixture verifier' };
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.quality[0]!.status, 'none');
  assert.equal(fs.existsSync(input.directory), false);
});

const captureGapReason = 'no suite loaded this file, so it has no coverage record (a child process needs QUALITY_GATE_V8_CAPTURE and the shared core preload in NODE_OPTIONS)';

function writeGapReport(input: QualityInput, partial: boolean): void {
  const missing = { relativePath: 'source.js', name: 'missingBody', complexity: 2, classification: 'new', unverified: captureGapReason };
  const other = partial
    ? { relativePath: 'source.js', name: 'coveredBody', complexity: 2, classification: 'new', crap: 2, coverage: 1 }
    : { ...missing, name: 'anotherMissingBody' };
  const report = { changedMetrics: [missing, other], failures: [], unverified: partial ? [missing] : [missing, other] };
  fs.writeFileSync(path.join(input.project, 'gate', 'bin', 'quality-gate.js'), 'process.stdout.write(' + JSON.stringify(JSON.stringify(report)) + ');');
}

function verifyDeliveredQuality(input: QualityInput, mode = 'enforce', filingError?: string) {
  const { createSubmissions } = require('../src/lib/store/submissions.js');
  const ticket = {
    id: 'quality-fixture', ref: 'SQ-quality', comments: [],
    executorVerify: 'node -e "process.exit(0)"', executorVerifyKind: 'command',
    submission: { base: input.base, commit: 'candidate', changedPaths: input.changedPaths, integration: { outcome: 'delivered' } },
  };
  const debts: unknown[] = [];
  fs.mkdirSync(path.join(input.project, 'gate', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(input.project, 'gate', 'lib', 'core.mjs'), '');
  const submissions = createSubmissions({
    fs, path, crypto: require('node:crypto'),
    getTicket: () => ticket, readMeta: () => ({ path: input.project }), projectDir: () => path.join(input.project, 'board'),
    boardConfig: () => ({ integrationQuality: mode }),
    normalizeIntegrationVerifyTimeoutMs: () => input.timeoutMilliseconds,
    verifyCommandError: () => null, dispatchState: () => ({ evidenceDirectory: input.directory }),
    ensureDir: (directory: string) => fs.mkdirSync(directory, { recursive: true }),
    listTickets: () => [], createTicket: (_slug: string, debt: unknown) => {
      if (filingError) throw new Error(filingError);
      debts.push(debt);
    },
    transaction: (callback: () => void) => callback(),
    withTicketLock: (_slug: string, _id: string, callback: () => unknown) => callback(),
    putTicket: () => {}, queueEventNotification: () => {}, addComment: () => ({ ticket }),
  });
  return { result: submissions.verifyIntegration('quality-project', ticket.ref), debts };
}

test('whole-run capture gaps record their reason without filing debt tickets', (context) => {
  const input = withQualityFixture(context, 2, false);
  writeGapReport(input, false);
  const { result, debts } = verifyDeliveredQuality(input);
  assert.equal(result.ok, true);
  assert.deepEqual(debts, []);
  const quality = result.verify.quality[0];
  assert.equal(quality.captureGap, captureGapReason);
  const receipt = JSON.parse(fs.readFileSync(quality.receipt, 'utf8'));
  assert.equal(receipt.captureGap, captureGapReason);
  assert.match(receipt.coverageSupport, /Vitest.*no measurement.*Vitest workers/);
  assert.equal(fs.existsSync(path.join(path.dirname(quality.receipt), 'coverage')), false);
});

test('partial capture gaps still file one debt ticket', (context) => {
  const input = withQualityFixture(context, 2, false);
  writeGapReport(input, true);
  const { result, debts } = verifyDeliveredQuality(input);
  assert.equal(result.ok, true);
  assert.equal(result.verify.quality[0].captureGap, undefined);
  assert.equal(debts.length, 1);
});

test('partial debt scope includes only unverified candidate files without release fragments or board docs', (context) => {
  const input = withQualityFixture(context, 2, false);
  writeGapReport(input, true);
  input.changedPaths.push('.release/unreleased/SQ-source.md', 'docs/guide.md', 'covered.js');
  const unverified = ['source.js', 'docs/guide.md', '.release/unreleased/SQ-source.md'].map((relativePath) => ({
    relativePath, name: 'missingBody', complexity: 2, unverified: 'no authentic executed source map',
  }));
  const report = { changedMetrics: unverified, failures: [], unverified };
  fs.writeFileSync(path.join(input.project, 'gate', 'bin', 'quality-gate.js'), 'process.stdout.write(' + JSON.stringify(JSON.stringify(report)) + ');');
  const { result, debts } = verifyDeliveredQuality(input);
  assert.equal(result.ok, true);
  assert.deepEqual((debts[0] as { files: string[] }).files, ['source.js']);
});

test('debt filing failure preserves successful delivery verification and records its receipt note', (context) => {
  const input = withQualityFixture(context, 2, false);
  writeGapReport(input, true);
  let delivery: ReturnType<typeof verifyDeliveredQuality> | undefined;
  assert.doesNotThrow(() => { delivery = verifyDeliveredQuality(input, 'enforce', 'forced createTicket refusal'); });
  assert.ok(delivery);
  const { result, debts } = delivery;
  assert.equal(result.ok, true);
  assert.equal(result.verify.status, 'passed');
  assert.deepEqual(debts, []);
  const quality = result.verify.quality[0];
  assert.equal(quality.debtTicketNote, 'debt ticket not filed: forced createTicket refusal');
  assert.equal(JSON.parse(fs.readFileSync(quality.receipt, 'utf8')).debtTicketNote, quality.debtTicketNote);
});

test('unverified rows outside candidate scope record a receipt gap without filing debt', (context) => {
  const input = withQualityFixture(context, 2, false);
  writeGapReport(input, true);
  fs.writeFileSync(path.join(input.project, 'covered.js'), 'function coveredBody() { return true; }');
  input.changedPaths = ['covered.js', '.release/unreleased/SQ-source.md'];
  const { result, debts } = verifyDeliveredQuality(input);
  assert.equal(result.ok, true);
  assert.deepEqual(debts, []);
  const quality = result.verify.quality[0];
  assert.match(JSON.parse(fs.readFileSync(quality.receipt, 'utf8')).debtTicketNote, /debt ticket not filed: no candidate source\/test paths/);
});

test('report mode records measured failures without refusing the verifier', (context) => {
  const input = withQualityFixture(context, 7, true);
  const { result } = verifyDeliveredQuality(input, 'report');
  assert.equal(result.ok, true);
  assert.equal(result.verify.status, 'passed');
  const quality = result.verify.quality[0];
  assert.equal(quality.status, 'failed');
  assert.equal(quality.failures.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(quality.receipt, 'utf8')).mode, 'report');
});

test('off mode skips registry access and capture while verifying once', (context) => {
  const input = withQualityFixture(context, 7, true);
  fs.writeFileSync(path.join(input.project, 'claude', 'plugins', 'installed_plugins.json'), '{invalid');
  let calls = 0;
  const result = runIntegrationQuality([input], (environment) => {
    calls += 1;
    assert.equal(environment, process.env);
    return { kind: 'command', status: 'passed', evidence: 'off verifier' };
  }, process.env, { mode: 'off' });
  assert.equal(calls, 1);
  assert.equal(result.status, 'passed');
  assert.equal(result.quality[0]!.status, 'none');
  assert.equal(fs.existsSync(input.directory), false);
});

test('capture is removed after measurement and when verification throws', (context) => {
  const input = withQualityFixture(context, 3, true);
  runIntegrationQuality([input], (environment) => {
    fs.writeFileSync(path.join(environment.QUALITY_GATE_V8_CAPTURE!, 'capture.json'), '{}');
    return { kind: 'command', status: 'passed', evidence: 'captured' };
  });
  assert.equal(fs.existsSync(path.join(input.directory, 'coverage')), false);
  assert.throws(() => runIntegrationQuality([input], () => { throw new Error('verifier threw'); }), /verifier threw/);
  assert.equal(fs.existsSync(path.join(input.directory, 'coverage')), false);
});

test('keepCapture retains raw evidence only when explicitly requested', (context) => {
  const input = withQualityFixture(context, 3, true);
  runIntegrationQuality([input], () => ({ kind: 'command', status: 'passed', evidence: 'debug capture' }), process.env, { keepCapture: true });
  assert.equal(fs.existsSync(path.join(input.directory, 'coverage')), true);
});

test('board configuration validates integration quality and MCP exposes the same modes', (context) => {
  const input = withQualityFixture(context, 3, true);
  const store = require('../lib/store.js');
  const { slug } = store.ensureProject(input.project);
  assert.equal(store.boardConfig(slug).integrationQuality, 'enforce');
  for (const mode of ['report', 'off', 'enforce']) {
    assert.equal(store.setBoardConfig(slug, { integrationQuality: mode }).config.integrationQuality, mode);
  }
  assert.throws(() => store.setBoardConfig(slug, { integrationQuality: 'ignore' }), /integrationQuality must be/);
  const mcp = require('../lib/mcp.js');
  const { makeCliRunner } = require('./_helpers.js');
  const { runCli } = makeCliRunner(path.resolve(__dirname, '../bin/sidequest.js'), { ...process.env, CLAUDE_PROJECT_DIR: input.project }, { cwd: input.project });
  const cli = runCli(['board-config', '--integration-quality', 'report', '--json']);
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).integrationQuality, 'report');
  const tools = mcp.tools || mcp.TOOLS;
  assert.deepEqual(tools.find((tool: { name: string }) => tool.name === 'board_config').inputSchema.properties.integrationQuality.enum, ['enforce', 'report', 'off']);
});
