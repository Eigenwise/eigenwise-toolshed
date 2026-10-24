import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runIntegrationQuality, type QualityInput } from '../src/lib/integration-quality.js';

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
