import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { crapReport, formatCrapReport, writeReceipt } from '../lib/crap.mjs';
import { acquireCoverage } from '../lib/lcov.mjs';
import { decodeMappings, locateSourceMap, sourceMapShapeRefusal, translateCoverage } from '../lib/source-map-translation.mjs';
import { compile, encodeVlq, generatedLcov } from './fixtures/source-map/compile.mjs';

const writeCoverageScript = fileURLToPath(new URL('./fixtures/source-map/write-coverage.mjs', import.meta.url));
const coverageCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(writeCoverageScript.replaceAll('\\', '/'))}`;
const WIDGET = 'export function widget(value) {\n  if (value) return 1;\n  return 2;\n}\n';
const GADGET = 'gadget line one\ngadget line two\n';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const createdAllowed = { hashes: {}, allowsCreated: true, changedWhen: 'during coverageCommand' };
const widgetHits = { '0:2': 1, '0:3': 0 };

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function project(context, files = { 'src/widget.js': WIDGET }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-source-map-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.mkdirSync(path.join(root, '.claude/quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: ['src'] }));
  return root;
}

function compileWidget(root, options = {}) {
  return compile({ generatedPath: path.join(root, 'out/widget.out'), sources: [path.join(root, 'src/widget.js')], ...options });
}

function planCoverage(root, lcov, rewrite = {}) {
  fs.writeFileSync(path.join(root, 'coverage-plan.json'), JSON.stringify({ lcov, rewrite }));
}

function translated(root, compiled, witness = createdAllowed, hashes = {}) {
  return translateCoverage({ text: generatedLcov('out/widget.out', compiled, widgetHits), hashes }, root, witness);
}

function onlyRefusal(result) {
  assert.deepEqual(result.sourceMapTranslations, []);
  assert.equal(result.sourceMapRefusals.length, 1);
  return result.sourceMapRefusals[0].reason;
}

async function widgetRow(root, options) {
  const report = await crapReport({ project: root, base: 'HEAD', ...options });
  return { report, rows: formatCrapReport(report) };
}

for (const placement of ['inline', 'sibling']) {
  test(`translated body reports coverage=50.00% through a${placement === 'inline' ? 'n' : ''} ${placement} map`, async (context) => {
    const root = project(context);
    const compiled = compileWidget(root, { placement });
    planCoverage(root, generatedLcov('out/widget.out', compiled, widgetHits, [{ key: '0:1', name: 'widget', count: 1 }]));
    const { report, rows } = await widgetRow(root, { coverageCommand });
    assert.match(rows, /^PASS src\/widget\.js:1 widget cc=2 coverage=50\.00% CRAP=2\.5000/m);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.sourceMapRefusals, []);
    const [translation] = report.sourceMapTranslations;
    assert.deepEqual(translation.generated, { path: 'out/widget.out', sha256: sha256(fs.readFileSync(compiled.generatedPath)) });
    assert.equal(translation.map.kind, placement === 'inline' ? 'inline' : 'file');
    assert.equal(translation.map.path, placement === 'inline' ? null : 'out/widget.out.map');
    assert.deepEqual(translation.sources, [{ path: 'src/widget.js', sha256: sha256(WIDGET) }]);
  });
}

test('the receipt records source map translations and refusals', async (context) => {
  const root = project(context, { 'src/widget.js': WIDGET, 'src/other.js': 'export function other() {\n  return 3;\n}\n' });
  const compiled = compileWidget(root, { placement: 'declared' });
  const other = compile({ generatedPath: path.join(root, 'out/other.out'), sources: [path.join(root, 'src/other.js')], mapOverrides: { sourcesContent: undefined } });
  planCoverage(root, generatedLcov('out/widget.out', compiled, widgetHits) + generatedLcov('out/other.out', other, { '0:2': 1 }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  const { report } = await widgetRow(root, { coverageCommand });
  const receipt = JSON.parse(fs.readFileSync(writeReceipt(report, path.join(root, 'receipts')), 'utf8'));
  assert.deepEqual(receipt.sourceMapTranslations.map((entry) => entry.generated.path), ['out/widget.out']);
  assert.equal(receipt.sourceMapTranslations[0].map.path, 'out/widget.out.map');
  assert.deepEqual(receipt.sourceMapRefusals, [{ generated: 'out/other.out', reason: 'source map lacks sourcesContent text for every source; enable sourcesContent in the generator' }]);
  assert.ok(report.warnings.some((warning) => warning.startsWith('Source map translation refused for out/other.out')));
  assert.match(formatCrapReport(report), /^PASS src\/other\.js:1 other cc=1 coverage=unverified .*Missing executable LCOV lines/m);
});

test('an unmapped executable line stays UNVERIFIED instead of being guessed', async (context) => {
  const root = project(context);
  const compiled = compileWidget(root, { unmapped: [{ source: 0, line: 3 }] });
  planCoverage(root, generatedLcov('out/widget.out', compiled, { '0:2': 1, '0:3': 1 }));
  const { rows } = await widgetRow(root, { coverageCommand });
  assert.match(rows, /^UNVERIFIED src\/widget\.js:1 widget: Missing executable LCOV lines/m);
});

test('translated body reports coverage=50.00% from existing LCOV only with capture-time hashes of the generated file and map', async (context) => {
  const root = project(context);
  const compiled = compileWidget(root);
  fs.mkdirSync(path.join(root, 'coverage'));
  fs.writeFileSync(path.join(root, 'coverage/lcov.info'), generatedLcov('out/widget.out', compiled, widgetHits));
  const witness = { 'out/widget.out': sha256(fs.readFileSync(compiled.generatedPath)), 'out/widget.out.map': sha256(fs.readFileSync(compiled.mapPath)) };
  fs.writeFileSync(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify(witness));
  assert.match((await widgetRow(root, {})).rows, /^PASS src\/widget\.js:1 widget cc=2 coverage=50\.00%/m);
  fs.writeFileSync(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ 'out/widget.out': witness['out/widget.out'] }));
  const { report, rows } = await widgetRow(root, {});
  assert.match(rows, /^UNVERIFIED src\/widget\.js:1 widget: Coverage source hash is missing or differs/m);
  assert.match(report.sourceMapRefusals[0].reason, /source map out\/widget\.out\.map has no capture-time SHA-256 in .*lcov\.info\.sources\.json/);
  fs.writeFileSync(path.join(root, 'coverage/lcov.info.sources.json'), JSON.stringify({ ...witness, 'src/widget.js': sha256('stale') }));
  assert.match((await widgetRow(root, {})).report.sourceMapRefusals[0].reason, /differs from the scored-source hash of src\/widget\.js/);
});

test('a multi-source map splits into one SF record per original source', (context) => {
  const root = project(context, { 'src/widget.src': 'widget one\nwidget two\nwidget three\n', 'src/gadget.src': GADGET });
  const compiled = compile({ generatedPath: path.join(root, 'out/bundle.out'), sources: [path.join(root, 'src/widget.src'), path.join(root, 'src/gadget.src')], placement: 'inline' });
  const lcov = generatedLcov('out/bundle.out', compiled, { '0:1': 2, '0:3': 0, '1:2': 5 }, [{ key: '1:1', name: 'gadget', count: 4 }]);
  const result = translateCoverage({ text: lcov, hashes: {} }, root, createdAllowed);
  assert.ok(result.text.startsWith(lcov));
  assert.ok(result.text.includes('SF:src/widget.src\nDA:1,2\nDA:3,0\nLF:2\nLH:1\nend_of_record'));
  assert.ok(result.text.includes('SF:src/gadget.src\nFN:1,gadget\nFNDA:4,gadget\nDA:2,5\nLF:1\nLH:1\nend_of_record'));
  assert.deepEqual(result.sourceMapTranslations[0].sources.map((source) => source.path), ['src/widget.src', 'src/gadget.src']);
  assert.deepEqual(result.hashes, { 'src/widget.src': sha256('widget one\nwidget two\nwidget three\n'), 'src/gadget.src': sha256(GADGET) });
});

test('a record without a map, or naming no file, passes through untouched', (context) => {
  const root = project(context, { 'src/plain.js': 'plain\n' });
  const text = 'SF:src/plain.js\nDA:1,1\nend_of_record\nSF:src/missing.js\nDA:1,1\nend_of_record\n';
  const result = translateCoverage({ text, hashes: { 'src/plain.js': sha256('plain\n') } }, root, createdAllowed);
  assert.equal(result.text, text);
  assert.deepEqual(result.hashes, { 'src/plain.js': sha256('plain\n') });
  assert.deepEqual([result.sourceMapTranslations, result.sourceMapRefusals], [[], []]);
  const missing = { text: '', hashes: {}, reason: 'No LCOV' };
  assert.deepEqual(translateCoverage(missing, root, createdAllowed), { ...missing, sourceMapTranslations: [], sourceMapRefusals: [] });
});

test('refuses a map whose sourcesContent differs from the source on disk', (context) => {
  const root = project(context);
  const compiled = compileWidget(root);
  fs.writeFileSync(path.join(root, 'src/widget.js'), WIDGET.replace('return 2', 'return 3'));
  assert.equal(onlyRefusal(translated(root, compiled)), 'map sourcesContent differs from the on-disk bytes of src/widget.js');
});

test('refuses a map re-pointed at another source', (context) => {
  const root = project(context, { 'src/widget.js': WIDGET, 'src/gadget.src': GADGET });
  const compiled = compileWidget(root, { mapOverrides: { sources: ['../src/gadget.src'] } });
  assert.equal(onlyRefusal(translated(root, compiled)), 'map sourcesContent differs from the on-disk bytes of src/gadget.src');
});

test('refuses a source that resolves outside the project', (context) => {
  const root = project(context);
  const compiled = compileWidget(root, { mapOverrides: { sourceRoot: '../../outside/' } });
  assert.match(onlyRefusal(translated(root, compiled)), /^map source \.\.\/src\/widget\.js resolves outside the project/);
});

test('refuses out-of-bounds mapping segments', (context) => {
  const root = project(context);
  const pastOriginal = compileWidget(root, { extraSegment: { generatedLine: 1, text: [0, 0, 98, 0].map(encodeVlq).join('') } });
  assert.equal(onlyRefusal(translated(root, pastOriginal)), 'mapping segment at generated line 1 points at line 99 of src/widget.js, which has 5 lines');
  const pastColumn = compileWidget(root, { extraSegment: { generatedLine: 2, text: [500, 0, 0, 0].map(encodeVlq).join('') } });
  assert.equal(onlyRefusal(translated(root, pastColumn)), 'mapping segment at generated line 2 column 500 is outside the generated file');
  const unknownSource = compileWidget(root, { extraSegment: { generatedLine: 1, text: [0, 3, 0, 0].map(encodeVlq).join('') } });
  assert.match(onlyRefusal(translated(root, unknownSource)), /names source index 3, which the map does not list/);
  const pastEnd = compileWidget(root, { mapOverrides: { mappings: ';;AAAA;AACA;AACA;AACA;;AAAA' } });
  assert.equal(onlyRefusal(translated(root, pastEnd)), 'mapping segment at generated line 8 column 0 is outside the generated file');
});

for (const changed of ['generated file', 'source map']) {
  test(`refuses a ${changed} rewritten during the command`, async (context) => {
    const root = project(context);
    const compiled = compileWidget(root);
    const target = changed === 'generated file' ? compiled.generatedPath : compiled.mapPath;
    planCoverage(root, generatedLcov('out/widget.out', compiled, widgetHits), { [target]: fs.readFileSync(target, 'utf8') + '\n' });
    const input = await acquireCoverage(root, { coverageCommand }, ['src/widget.js']);
    assert.equal(onlyRefusal(input), `${changed} ${path.relative(root, target).replaceAll('\\', '/')} changed during coverageCommand`);
  });
}

test('a command may create the generated file and map it runs', async (context) => {
  const root = project(context);
  const compiled = compileWidget(root);
  const created = { [compiled.generatedPath]: fs.readFileSync(compiled.generatedPath, 'utf8'), [compiled.mapPath]: fs.readFileSync(compiled.mapPath, 'utf8') };
  fs.rmSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'out'));
  planCoverage(root, generatedLcov('out/widget.out', compiled, widgetHits), created);
  const input = await acquireCoverage(root, { coverageCommand }, ['src/widget.js']);
  assert.deepEqual(input.sourceMapRefusals, []);
  assert.ok(input.text.includes('SF:src/widget.js\nDA:2,1\nDA:3,0\n'));
});

test('a tracked generated file must match its committed blob apart from a trailing sourceMappingURL line', (context) => {
  const root = project(context);
  const compiled = compileWidget(root, { placement: 'inline' });
  const mapped = fs.readFileSync(compiled.generatedPath, 'utf8');
  fs.writeFileSync(compiled.generatedPath, mapped.replace(/\/\/# sourceMappingURL=.*\n$/, ''));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  fs.writeFileSync(compiled.generatedPath, mapped);
  assert.deepEqual(translated(root, compiled).sourceMapRefusals, []);
  fs.writeFileSync(compiled.generatedPath, mapped.replace('generated by', 'regenerated by'));
  assert.equal(onlyRefusal(translated(root, compiled)), 'tracked generated file out/widget.out differs from its committed blob beyond a trailing sourceMappingURL line; executed code must be the shipped code');
});

test('map discovery and shape refusals name the reason', (context) => {
  const root = project(context);
  const generated = path.join(root, 'out/widget.out');
  fs.mkdirSync(path.dirname(generated));
  assert.equal(locateSourceMap(generated, 'code\n'), null);
  assert.throws(() => locateSourceMap(generated, '//# sourceMappingURL=absent.map\n'), /declared source map .*absent\.map is missing/);
  assert.throws(() => locateSourceMap(generated, '//# sourceMappingURL=https://example.invalid/x.map\n'), /neither a data: URL nor a local path/);
  assert.throws(() => locateSourceMap(generated, '//# sourceMappingURL=data:application/json\n'), /not a valid data: URL/);
  assert.equal(locateSourceMap(generated, `/*# sourceMappingURL=data:application/json,${encodeURIComponent('{"version":3}')} */\n`).bytes.toString(), '{"version":3}');
  fs.writeFileSync(path.join(root, 'out/url.map'), '{}');
  assert.equal(locateSourceMap(generated, `//# sourceMappingURL=${pathToFileURL(path.join(root, 'out/url.map')).href}\n`).kind, 'file');
  assert.equal(sourceMapShapeRefusal({ version: 2 }), 'source map is not version 3');
  assert.match(sourceMapShapeRefusal({ version: 3, sections: [] }), /indexed source maps/);
  assert.match(sourceMapShapeRefusal({ version: 3, sources: [] }), /lacks string mappings/);
  assert.match(sourceMapShapeRefusal({ version: 3, mappings: '', sources: ['a'], sourcesContent: [null] }), /lacks sourcesContent/);
  assert.equal(sourceMapShapeRefusal({ version: 3, mappings: '', sources: ['a'], sourcesContent: ['a'] }), null);
  fs.writeFileSync(generated + '.map', 'not json');
  fs.writeFileSync(generated, 'code\n');
  const result = translateCoverage({ text: 'SF:out/widget.out\nDA:1,1\nend_of_record\n', hashes: {} }, root, createdAllowed);
  assert.match(onlyRefusal(result), /^source map is not valid JSON/);
});

test('malformed mappings refuse instead of decoding partially', () => {
  assert.deepEqual(decodeMappings('AAAA;AACA,EAAE;;C'), [[{ generatedColumn: 0, source: 0, originalLine: 0 }], [{ generatedColumn: 0, source: 0, originalLine: 1 }, { generatedColumn: 2, source: 0, originalLine: 1 }], [], []]);
  assert.throws(() => decodeMappings('AA!A'), /invalid VLQ character "!"/);
  assert.throws(() => decodeMappings('AAAg'), /unterminated VLQ value/);
  assert.throws(() => decodeMappings('AA'), /has 2 fields/);
  assert.deepEqual(decodeMappings('D'), [[]]);
});
