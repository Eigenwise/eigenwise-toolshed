import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureFiles } from '../lib/measure.mjs';

const pluginRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const coreUrl = pathToFileURL(path.join(pluginRoot, 'lib/core.mjs')).href;
const cliPath = path.join(pluginRoot, 'bin/quality-gate.js');
const calledSource = 'module.exports = function subject(value) { return value + 1; };\nmodule.exports(1);\n';

function runNode(argumentsList, environment = process.env) {
  const { NODE_TEST_CONTEXT, NODE_V8_COVERAGE, ...inherited } = environment;
  return spawnSync(process.execPath, argumentsList, { encoding: 'utf8', timeout: 30000, env: inherited });
}

async function externalFixture(context, sources = { 'subject.cjs': calledSource }) {
  const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'quality-external-')));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'nonrepo');
  const coverageDirectory = path.join(root, 'coverage');
  await fs.mkdir(projectRoot);
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  const sourcePaths = [];
  for (const [name, text] of Object.entries(sources)) {
    const sourcePath = path.join(root, name);
    await fs.writeFile(sourcePath, text);
    sourcePaths.push(sourcePath);
  }
  return { root, projectRoot, coverageDirectory, sourcePaths };
}

function capture(fixture, argumentsList = fixture.sourcePaths) {
  const { NODE_TEST_CONTEXT, NODE_V8_COVERAGE, NODE_OPTIONS, QUALITY_GATE_V8_CAPTURE, ...environment } = process.env;
  const execution = spawnSync(process.execPath, argumentsList, { encoding: 'utf8', timeout: 30000, env: { ...environment, NODE_OPTIONS: '--import=' + coreUrl, QUALITY_GATE_V8_CAPTURE: fixture.coverageDirectory } });
  assert.equal(execution.status, 0, execution.stderr);
}

function externalReport(fixture, files = []) {
  return measureFiles(files, { ...fixture, externalNewFiles: fixture.sourcePaths });
}

test('explicit external-only nonrepo measurement never invokes Git and records admission, bytes and evaluator versions', async (context) => {
  const fixture = await externalFixture(context);
  capture(fixture);
  const commands = [];
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (...argumentsList) => { commands.push(argumentsList[0]); return original(...argumentsList); };
  syncBuiltinESMExports();
  let report;
  try {
    report = await externalReport(fixture);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(commands.includes('git'), false, 'external-only measurement must never invoke Git');
  assert.equal(report.changedMetrics.length, 1, 'declared external file must produce an enforced body without a repository');
  const [metric] = report.changedMetrics;
  assert.equal(metric.classification, 'new');
  assert.equal(metric.admission, 'external-new');
  assert.equal(metric.relativePath, fixture.sourcePaths[0].replaceAll('\\', '/'));
  assert.equal(metric.sourceHash, crypto.createHash('sha256').update(await fs.readFile(fixture.sourcePaths[0])).digest('hex'));
  assert.equal(metric.evaluatorVersions.typescript, '7.0.2');
  assert.equal(metric.evaluatorVersions.node, process.version);
  assert.equal(metric.coverage, 1);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.unverified, []);
});

test('explicit external file bypasses Git baseline lookup even when also selected', async (context) => {
  const fixture = await externalFixture(context);
  capture(fixture);
  let report;
  await assert.doesNotReject(async () => { report = await measureFiles(fixture.sourcePaths, { ...fixture, externalNewFiles: fixture.sourcePaths, base: 'HEAD' }); }, 'explicit admission must bypass Git baseline lookup');
  assert.equal(report.changedMetrics[0].classification, 'new', 'explicit admission must use an empty baseline without Git');
});

test('repeatable CLI external declarations need coverage but no base or repository', async (context) => {
  const fixture = await externalFixture(context, { 'subject.cjs': calledSource, 'subject.js': calledSource });
  capture(fixture, ['-e', fixture.sourcePaths.map(sourcePath => `require(${JSON.stringify(sourcePath)});`).join('')]);
  const execution = runNode([cliPath, 'measure', '--project', fixture.projectRoot, '--coverage', fixture.coverageDirectory, '--new-external-file', fixture.sourcePaths[0], '--new-external-file', fixture.sourcePaths[1]]);
  assert.equal(execution.status, 0, 'public external-only CLI must succeed: ' + execution.stderr);
  assert.equal(JSON.parse(execution.stdout).changedMetrics.length, 2);
  const missing = runNode([cliPath, 'measure', '--new-external-file', fixture.sourcePaths[0]]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /coverage/);
  const noFiles = runNode([cliPath, 'measure', '--coverage', fixture.coverageDirectory]);
  assert.equal(noFiles.status, 1);
  assert.match(noFiles.stderr, /files/);
  assert.match(runNode([cliPath, '--help']).stdout, /new-external-file.*absolute path/);
  const wrongCommand = runNode([cliPath, 'crap', '--new-external-file', fixture.sourcePaths[0]]);
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /new-external-file.*measure/);
});

test('external CJS and native MJS keep exact nested and same-name runtime ownership', async (context) => {
  const source = 'function outer() { function duplicate() { return 1; } return duplicate(); }\nfunction other() { function duplicate() { return 2; } return duplicate(); }\nconst first = { duplicate() { return 3; }, async asynchronous() { return 4; }, get value() { return 5; } };\nconst second = { duplicate() { return 6; } };\nexports.subject = function(value) { return value + 1; };\nmodule.exports.arrow = value => value + 1;\nclass Subject { method() { return 7; } static unsupported() { return 8; } }\nouter(); other(); first.duplicate(); first.asynchronous(); void first.value; exports.subject(1); module.exports.arrow(1); new Subject().method();\n';
  const fixture = await externalFixture(context, { 'subject.cjs': source, 'native.mjs': 'export function subject() { return 1; }\nsubject();\n' });
  capture(fixture, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(fixture.sourcePaths[0]).href)}); await import(${JSON.stringify(pathToFileURL(fixture.sourcePaths[1]).href)});`]);
  const report = await externalReport(fixture);
  assert.ok(report.metrics.length > 0, 'explicit external sources must have independently measured runtime rows');
  assert.deepEqual(report.metrics.filter(metric => metric.name === 'duplicate').map(metric => metric.coverage), [1, 1, 1, 0], 'same-name nested and sibling bodies must remain separate');
  assert.equal(report.metrics.find(metric => metric.name === 'unsupported').coverage, undefined);
  assert.match(report.metrics.find(metric => metric.name === 'unsupported').unverified, /exact runtime range/);
  assert.equal(report.metrics.at(-1).coverage, 1);
});

test('external measured-zero CC2 fails at six and absent nested bodies stay unverified', async (context) => {
  const fixture = await externalFixture(context, { 'subject.js': 'function idle(value) { return value ? 1 : 0; }\nfunction absent() { return () => 1; }\n' });
  capture(fixture);
  const report = await externalReport(fixture);
  assert.ok(report.metrics.length > 0, 'explicit external sources must have independently measured runtime rows');
  assert.equal(report.metrics[0].coverage, 0, 'an exact zero-hit runtime body must stay measured zero');
  assert.equal(report.metrics[0].crap, 6);
  assert.equal(report.failures.length, 1);
  assert.match(report.metrics[2].unverified, /no captured exact runtime range/);
  assert.equal(report.metrics[2].coverage, undefined);
});

test('child-only external execution requires the inherited canonical core preload', async (context) => {
  const fixture = await externalFixture(context);
  capture(fixture, ['-e', `const { spawnSync } = require('node:child_process'); const execution = spawnSync(process.execPath, [${JSON.stringify(fixture.sourcePaths[0])}], { env: process.env, timeout: 10000 }); process.exitCode = execution.status;`]);
  const childReport = await externalReport(fixture);
  assert.equal(childReport.metrics.length, 1, 'child-only explicit external body must have a measured row');
  assert.equal(childReport.metrics[0].coverage, 1, 'child report must measure the child-only external body');
  const uncaptured = await externalFixture(context);
  capture(uncaptured, ['-e', `const { spawnSync } = require('node:child_process'); const environment = { ...process.env }; delete environment.NODE_OPTIONS; const execution = spawnSync(process.execPath, [${JSON.stringify(uncaptured.sourcePaths[0])}], { env: environment, timeout: 10000 }); process.exitCode = execution.status;`]);
  assert.match((await externalReport(uncaptured)).unverified[0].unverified, /no suite loaded.*child process/);
  const interrupted = await externalFixture(context, { 'subject.cjs': calledSource + 'setInterval(() => {}, 1000);\n' });
  const execution = spawnSync(process.execPath, interrupted.sourcePaths, { timeout: 2000, env: { ...process.env, NODE_OPTIONS: '--import=' + coreUrl, QUALITY_GATE_V8_CAPTURE: interrupted.coverageDirectory } });
  assert.equal(execution.error.code, 'ETIMEDOUT');
  assert.deepEqual(await fs.readdir(interrupted.coverageDirectory), [], 'interrupted child must leave no completed capture');
  assert.match((await externalReport(interrupted)).unverified[0].unverified, /no suite loaded/);
});

test('external one-byte source edits invalidate capture instead of acquiring a passing row', async (context) => {
  const fixture = await externalFixture(context);
  capture(fixture);
  await fs.writeFile(fixture.sourcePaths[0], calledSource.replace('+ 1', '+ 2'));
  const report = await externalReport(fixture);
  assert.ok(report.metrics.length > 0, 'explicit external sources must have independently measured runtime rows');
  assert.match(report.unverified[0].unverified, /executed bytes.*differ/, 'post-capture byte change must stay unverified');
  assert.equal(report.metrics[0].coverage, undefined);
});

test('external raw V8 and unmatched transformed source stay unverified', async (context) => {
  const fixture = await externalFixture(context);
  capture(fixture);
  const [captureFile] = await fs.readdir(fixture.coverageDirectory);
  const capturePath = path.join(fixture.coverageDirectory, captureFile);
  const report = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  delete report.qualityGate;
  await fs.writeFile(capturePath, JSON.stringify(report));
  const rawReport = await externalReport(fixture);
  assert.equal(rawReport.unverified.length, 1, 'raw V8 must produce an explicit unverified external row');
  assert.match(rawReport.unverified[0].unverified, /capture binding/, 'raw V8 must never prove external-source bytes');
  const changed = await externalFixture(context);
  capture(changed);
  await fs.writeFile(changed.sourcePaths[0], calledSource + 'void 0;\n');
  assert.match((await externalReport(changed)).unverified[0].unverified, /matching source map/);
  for (const sources of [['different.cjs'], ['subject.cjs', 'different.cjs']]) {
    const map = { version: 3, sources, sourcesContent: [calledSource], names: [], mappings: '' };
    const transformed = await externalFixture(context, { 'subject.cjs': calledSource + '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64') + '\n' });
    capture(transformed);
    await fs.writeFile(transformed.sourcePaths[0], calledSource);
    assert.match((await externalReport(transformed)).unverified[0].unverified, /matching source map/, 'unsupported maps must never acquire external-source proof');
  }
  const wrapped = await externalFixture(context);
  capture(wrapped, ['-e', `const Module = require('node:module'); Module.wrapper[0] += 'void 0;'; require(${JSON.stringify(wrapped.sourcePaths[0])});`]);
  assert.match((await externalReport(wrapped)).unverified[0].unverified, /executed bytes.*differ/, 'patched CJS wrapper must fail exact-byte admission');
});

test('external path and UTF8 refusals identify the declaration and return no passing report', async (context) => {
  const fixture = await externalFixture(context);
  const valid = fixture.sourcePaths[0];
  const invalidEncoding = path.join(fixture.root, 'invalid.cjs');
  await fs.writeFile(invalidEncoding, Buffer.from([0xff, 0xfe, 0x66, 0x00]));
  const unsupported = path.join(fixture.root, 'unsupported.txt');
  await fs.writeFile(unsupported, calledSource);
  const inProject = path.join(fixture.projectRoot, 'inside.cjs');
  await fs.writeFile(inProject, calledSource);
  const declarations = [
    ['subject.cjs', /absolute/],
    [path.join(fixture.root, 'missing.cjs'), /missing|ENOENT/],
    [fixture.root, /regular file/],
    [unsupported, /\.js.*\.cjs.*\.mjs/],
    [inProject, /outside.*project/],
    [fixture.root + path.sep + '..' + path.sep + path.basename(fixture.root) + path.sep + 'subject.cjs', /normalized|traversal/],
    [invalidEncoding, /UTF-8/],
  ];
  for (const [declaration, reason] of declarations) {
    await assert.rejects(measureFiles([], { ...fixture, externalNewFiles: [declaration] }), reason, 'invalid explicit declaration must refuse: ' + declaration);
  }
  await assert.rejects(measureFiles([], { ...fixture, externalNewFiles: [valid, valid] }), /duplicate/);
  if (process.platform === 'win32') {
    await assert.rejects(measureFiles([], { ...fixture, externalNewFiles: [valid, valid.replace('subject.cjs', 'SUBJECT.cjs')] }), /alias|duplicate/);
    await assert.rejects(measureFiles([valid.replace('subject.cjs', 'SUBJECT.cjs')], { ...fixture, externalNewFiles: [valid] }), /alias/);
  }
  const directoryAlias = path.join(fixture.root, 'alias');
  await fs.symlink(fixture.projectRoot, directoryAlias, 'junction');
  await assert.rejects(measureFiles([], { ...fixture, externalNewFiles: [path.join(directoryAlias, 'inside.cjs')] }), /alias/);
  const execution = runNode([cliPath, 'measure', '--project', fixture.projectRoot, '--coverage', fixture.coverageDirectory, '--new-external-file', invalidEncoding]);
  assert.equal(execution.status, 1);
  assert.equal(execution.stdout, '');
  assert.match(execution.stderr, /invalid\.cjs.*UTF-8/);
});

test('external BOM fails closed while preserving the original source bytes', async (context) => {
  const fixture = await externalFixture(context, { 'subject.cjs': '﻿' + calledSource });
  capture(fixture);
  await assert.rejects(externalReport(fixture), /BOM.*offset/, 'BOM parser offsets must not produce any passing external row');
  assert.equal((await fs.readFile(fixture.sourcePaths[0]))[0], 0xef);
});

test('mixed repository and external measurement keeps repository baseline authority', async (context) => {
  const fixture = await externalFixture(context);
  const repositoryFile = path.join(fixture.projectRoot, 'repo.mjs');
  await fs.writeFile(repositoryFile, 'export function subject(value) { return value; }\nsubject(1);\n');
  for (const argumentsList of [['init', '-q'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']]) {
    const execution = spawnSync('git', argumentsList, { cwd: fixture.projectRoot, encoding: 'utf8', timeout: 30000 });
    assert.equal(execution.status, 0, execution.stderr);
  }
  await fs.writeFile(repositoryFile, 'export function subject(value) { return value + 1; }\nsubject(1);\n');
  capture(fixture, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(repositoryFile).href)}); await import(${JSON.stringify(pathToFileURL(fixture.sourcePaths[0]).href)});`]);
  await assert.rejects(measureFiles(['repo.mjs'], { ...fixture, externalNewFiles: fixture.sourcePaths }), /base/, 'mixed measurement requires the repository base');
  const report = await measureFiles(['repo.mjs'], { ...fixture, externalNewFiles: fixture.sourcePaths, base: 'HEAD' });
  assert.deepEqual(report.changedMetrics.map(metric => [metric.relativePath, metric.classification]), [['repo.mjs', 'legacy-unchanged'], [fixture.sourcePaths[0].replaceAll('\\', '/'), 'new']]);
  assert.equal(report.changedMetrics[0].admission, undefined);
  await assert.rejects(measureFiles([fixture.sourcePaths[0]], { ...fixture, base: 'HEAD' }), /outside repository/);
});
