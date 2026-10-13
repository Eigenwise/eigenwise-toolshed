import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnalyzer, functionCoverage, originalOffsetMapper, readCoverage } from '../lib/core.mjs';
import { measureSource, readOutput } from '../lib/measure.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const corePath = new URL('../lib/core.mjs', import.meta.url).href;
const analyzer = await createAnalyzer(pluginRoot);
const { transform } = createRequire(import.meta.url)('esbuild');

test('historical export getter cannot cover the idle production body', () => {
  const descriptor = { identity: '<root>/FunctionDeclaration:negativeControlRecoveryGuidance#0', parent: '<root>', name: 'negativeControlRecoveryGuidance', start: 27983, end: 29293 };
  const records = [
    { functionName: descriptor.name, ranges: [{ startOffset: 1626, endOffset: 1663, count: 1 }] },
    { functionName: descriptor.name, ranges: [{ startOffset: 24396, endOffset: 25691, count: 0 }] },
  ];
  const result = functionCoverage(descriptor, [{ descriptors: [descriptor], records: [] }, { relativePath: 'lib/refusal-guidance.js', records }]);
  assert.equal(result.coverage, undefined, 'historical export getter is never accepted coverage');
  assert.match(result.unverified, /executed|capture|source map/);
});

async function captureFixture(text, extension = 'mjs') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-v8-'));
  const sourcePath = path.join(root, `subject.${extension}`);
  const coverageDirectory = path.join(root, 'coverage');
  await fs.mkdir(coverageDirectory);
  assert.deepEqual(await fs.readdir(coverageDirectory), []);
  await fs.writeFile(sourcePath, text);
  const { NODE_TEST_CONTEXT, NODE_V8_COVERAGE, NODE_OPTIONS, ...environment } = process.env;
  const execution = spawnSync(process.execPath, ['--import', corePath, sourcePath], { encoding: 'utf8', timeout: 30000, env: { ...environment, QUALITY_GATE_V8_CAPTURE: coverageDirectory } });
  assert.equal(execution.status, 0, execution.stderr);
  return { root, sourcePath, coverageDirectory };
}

async function fixtureMetrics(fixture) {
  return measureSource(fixture.sourcePath, await readCoverage(fixture.coverageDirectory), { projectRoot: fixture.root, analyzer });
}

test('same-byte direct source owns nested callbacks and distinguishes duplicate names and getters', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nconst exports = { get subject() { return subject; } };\nvoid exports.subject;\nconst first = { duplicate() { return 1; } };\nconst second = { duplicate() { return 2; } };\nfirst.duplicate();\n[1].map((value) => value + 1);\nvoid second;\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    assert.deepEqual(metrics.map((metric) => [metric.name, metric.coverage]), [['subject', 0], ['subject', 1], ['duplicate', 1], ['duplicate', 0], ['<anonymous>', 1]]);
    assert.ok(metrics.every((metric) => !metric.unverified));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('executed source mismatch stays unverified even when the path and ranges match', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    await fs.writeFile(fixture.sourcePath, 'export function subject() { return 2; }\nsubject();\n');
    const [metric] = await fixtureMetrics(fixture);
    assert.match(metric.unverified, /executed bytes.*differ/);
    assert.equal(metric.coverage, undefined);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('raw V8 reports cannot acquire executed-byte proof from the current file', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    const files = await fs.readdir(fixture.coverageDirectory);
    const reportPath = path.join(fixture.coverageDirectory, files[0]);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    delete report.qualityGate;
    await fs.writeFile(reportPath, JSON.stringify(report));
    const [metric] = await fixtureMetrics(fixture);
    assert.match(metric.unverified, /capture binding/);
    assert.equal(metric.coverage, undefined);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('owned spans exclude parameter callbacks and keep a returned nested arrow separate', async () => {
  const fixture = await captureFixture('function parameter(callback = () => 1) { return callback; }\nparameter(() => 2);\nconst outer = () => () => 3;\nouter();\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage]), [['parameter', 1], ['<anonymous>', 0], ['<anonymous>', 0], ['outer', 1], ['<anonymous>', 0]]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate exact runtime records and absent executed bytes stay unverified', async () => {
  const fixture = await captureFixture('export function subject() { return 1; }\nsubject();\n');
  try {
    const [file] = await fs.readdir(fixture.coverageDirectory);
    const reportPath = path.join(fixture.coverageDirectory, file);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const script = report.result.find(script => script.url === pathToFileURL(fixture.sourcePath).href);
    script.functions.push(script.functions.find(record => record.functionName === 'subject'));
    await fs.writeFile(reportPath, JSON.stringify(report));
    assert.match((await fixtureMetrics(fixture))[0].unverified, /ambiguous exact runtime range/);
    delete script.source;
    await fs.writeFile(reportPath, JSON.stringify(report));
    assert.match((await fixtureMetrics(fixture))[0].unverified, /missing executed script bytes/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function compilerFixture(source, changeOutput = text => text) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm', sourcemap: 'inline', sourcesContent: true, sourcefile: 'original.ts', minify: true });
  const fixture = await captureFixture(changeOutput(code));
  fixture.originalPath = path.join(fixture.root, 'original.ts');
  await fs.writeFile(fixture.originalPath, source);
  return fixture;
}

async function compilerMetrics(fixture) {
  return measureSource(fixture.originalPath, await readCoverage(fixture.coverageDirectory), { projectRoot: fixture.root, analyzer, outputPaths: [fixture.sourcePath] });
}

test('authentic compiler maps bind minified nested bodies without naming or scaling', async () => {
  const fixture = await compilerFixture('export function outer(values: number[]): number[] {\n  return values.map((value: number) => value + 1);\n}\nouter([1]);\n');
  try {
    const metrics = await compilerMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage]), [['outer', 1], ['<anonymous>', 1]]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function nativeTscOutput(compileRoot, source, module = 'esnext') {
  await fs.writeFile(path.join(compileRoot, 'original.ts'), source);
  const tsc = path.join(pluginRoot, 'node_modules/typescript/bin/tsc');
  const compile = spawnSync(process.execPath, [tsc, 'original.ts', '--inlineSourceMap', '--inlineSources', '--target', 'es2022', '--module', module], { cwd: compileRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  return fs.readFile(path.join(compileRoot, 'original.js'), 'utf8');
}

test('a boundary byte without its own exact native tsc correspondence stays unmapped', async () => {
  const source = 'const input: unknown = 1;\nexport const value = input;\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  try {
    const output = await nativeTscOutput(compileRoot, source);
    const data = JSON.parse(Buffer.from(output.match(/base64,([^\s]+)/)[1], 'base64').toString('utf8'));
    const toOriginal = originalOffsetMapper({ data, lineLengths: output.split('\n').map(line => line.length) }, source, output);
    const afterInput = output.indexOf(' = 1');
    assert.equal(source[toOriginal(afterInput)], ':', 'the preceding text alone reaches the erased type annotation');
    assert.equal(toOriginal(afterInput, 1), null);
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
  }
});

test('a native tsc block end before a re-indented closing brace binds through that brace', async () => {
  const source = 'export function outer(flag: boolean) {\nfunction inner() {\n  if (flag) return 1;\n  const unused = 2;\n  return unused;\n}\nreturn inner();\n}\nouter(true);\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    fixture = await captureFixture(await nativeTscOutput(compileRoot, source));
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const metrics = await compilerMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.unverified]), [['outer', undefined], ['inner', undefined]]);
    const inner = metrics.find(metric => metric.name === 'inner');
    assert.ok(inner.coverage > 0 && inner.coverage < 1, `the skipped tail measures as uncovered, got ${inner.coverage}`);
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});


test('native tsc typed-return declarations bind exact starts and independent nested bodies', async () => {
  const source = 'export function outer(flag: boolean): number {\nfunction inner(): number {\n  if (flag) return 1;\n  return 2;\n}\nreturn inner();\n}\nouter(true);\nouter(false);\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    const output = await nativeTscOutput(compileRoot, source);
    fixture = await captureFixture(output);
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const data = JSON.parse(Buffer.from(output.match(/base64,([^\s]+)/)[1], 'base64').toString('utf8'));
    const toOriginal = originalOffsetMapper({ data, lineLengths: output.split('\n').map(line => line.length) }, source, output);
    const original = await analyzer.collectFunctions(source, fixture.originalPath);
    const generated = await analyzer.collectFunctions(output, fixture.sourcePath);
    assert.equal(toOriginal(generated[0].bodyStart), null, 'native return annotation erases the exact body-opening anchor');
    assert.equal(toOriginal(generated[0].runtimeStart, 1), original[0].runtimeStart, 'native declaration start maps exactly after export');
    assert.equal(toOriginal(generated[0].end - 1), original[0].end - 1, 'native closing token maps exactly');
    const metrics = await compilerMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage, metric.unverified]), [['outer', 1, undefined], ['inner', 1, undefined]], 'typed-return bodies require exact native declaration-start ownership');
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('native tsc erased modifiers retain body-start authority', async () => {
  const source = 'class Base { method() { return 0; } }\nclass Derived extends Base {\n  public override method() { return 1; }\n  private hidden() { return 2; }\n  public call() { return this.hidden(); }\n}\nnew Derived().method();\nnew Derived().call();\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    fixture = await captureFixture(await nativeTscOutput(compileRoot, source));
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const metrics = await compilerMetrics(fixture);
    assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage, metric.unverified]), [['method', 0, undefined], ['method', 1, undefined], ['hidden', 1, undefined], ['call', 1, undefined]], 'erased declaration modifiers preserve exact body-opening support');
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('missing and ambiguous exact native declaration twins stay unverified', async () => {
  const source = 'export function subject(): number { return 1; }\nsubject();\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    fixture = await captureFixture(await nativeTscOutput(compileRoot, source));
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const scripts = await readCoverage(fixture.coverageDirectory);
    const original = await readOutput(fixture.originalPath, scripts, true, { projectRoot: fixture.root, analyzer });
    const output = await readOutput(fixture.sourcePath, scripts, false, { projectRoot: fixture.root, analyzer });
    const descriptor = original.descriptors[0];
    const capture = output.captures[0];
    assert.equal(functionCoverage(descriptor, [original, output]).coverage, 1, 'authentic exact native twin is measured before refusal controls');
    const twins = capture.descriptors;
    capture.descriptors = [];
    assert.match(functionCoverage(descriptor, [original, output]).unverified, /missing or ambiguous source-map correspondence/, 'both exact start anchors missing refuses');
    capture.descriptors = [...twins, ...twins];
    assert.match(functionCoverage(descriptor, [original, output]).unverified, /missing or ambiguous source-map correspondence/, 'two exact native twins refuse');
    capture.descriptors = twins.map(twin => ({ ...twin, end: twin.end - 1 }));
    assert.match(functionCoverage(descriptor, [original, output]).unverified, /missing or ambiguous source-map correspondence/, 'exact declaration start cannot replace the required exact end');
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('malformed compiler maps and a map naming another source stay unverified', async () => {
  const source = 'export function subject(): number { return 1; }\nsubject();\n';
  const malformed = await compilerFixture(source, text => text.replace(/base64,[^\s]+/, 'base64,e30='));
  try {
    assert.match((await compilerMetrics(malformed))[0].unverified, /matching source map/);
  } finally {
    await fs.rm(malformed.root, { recursive: true, force: true });
  }
  const wrongPath = await compilerFixture(source);
  try {
    const originalPath = wrongPath.originalPath;
    wrongPath.originalPath = path.join(wrongPath.root, 'different.ts');
    await fs.copyFile(originalPath, wrongPath.originalPath);
    assert.match((await compilerMetrics(wrongPath))[0].unverified, /matching source map/);
  } finally {
    await fs.rm(wrongPath.root, { recursive: true, force: true });
  }
});

test('an absent owned runtime record stays unverified rather than inheriting module execution', async () => {
  const fixture = await captureFixture('export function outer() { return () => 1; }\n');
  try {
    const metrics = await fixtureMetrics(fixture);
    const nested = metrics.find(metric => metric.name === '<anonymous>');
    assert.equal(nested.coverage, undefined);
    assert.match(nested.unverified, /no captured exact runtime range/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [declaration, invocation, expected] of [
  ['export function outer(flag: boolean): number {\nfunction inner(): number {\n  if (flag) return 1;\n  return 2;\n}\nreturn inner();\n}', 'outer(true); outer(false);', [['outer', 1], ['inner', 1]]],
  ['export default function outer(): { value: number } { return { value: 1 }; }', 'outer();', [['outer', 1]]],
  ['export async function outer(): Promise<number> { return 1; }', 'outer();', [['outer', 1]]],
  ['export function outer(): number { return 1; }', 'void 0;', [['outer', 0]]],
]) {
  test('CommonJS exported typed-return declaration: ' + declaration.split('\n')[0], async () => {
    const source = declaration + '\n' + invocation + '\n';
    const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
    let fixture;
    try {
      const output = await nativeTscOutput(compileRoot, source, 'node16');
      fixture = await captureFixture(output, 'cjs');
      fixture.originalPath = path.join(fixture.root, 'original.ts');
      await fs.writeFile(fixture.originalPath, source);
      const metrics = await compilerMetrics(fixture);
      assert.deepEqual(metrics.map(metric => [metric.name, metric.coverage]), expected, 'CommonJS exported typed-return bodies require exact native declaration ownership');
      assert.ok(metrics.every(metric => !metric.unverified), 'all independent CommonJS bodies have authentic ownership');
    } finally {
      await fs.rm(compileRoot, { recursive: true, force: true });
      if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('CommonJS exported exact native starts refuse missing, shifted and duplicate AST twins', async () => {
  const source = 'export function outer(flag: boolean): number {\nfunction inner(): number {\n  if (flag) return 1;\n  return 2;\n}\nreturn inner();\n}\nouter(true);\n';
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    const output = await nativeTscOutput(compileRoot, source, 'node16');
    fixture = await captureFixture(output, 'cjs');
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const data = JSON.parse(Buffer.from(output.match(/base64,([^\s]+)/)[1], 'base64').toString('utf8'));
    const toOriginal = originalOffsetMapper({ data, lineLengths: output.split('\n').map(line => line.length) }, source, output);
    const scripts = await readCoverage(fixture.coverageDirectory);
    const original = await readOutput(fixture.originalPath, scripts, true, { projectRoot: fixture.root, analyzer });
    const generated = await readOutput(fixture.sourcePath, scripts, false, { projectRoot: fixture.root, analyzer });
    const capture = generated.captures[0];
    const twins = capture.descriptors;
    const metrics = await compilerMetrics(fixture);
    assert.equal(metrics[0].coverage, 1, 'outer denominator excludes the uncovered nested tail');
    assert.ok(metrics[1].coverage > 0 && metrics[1].coverage < 1, 'inner denominator independently retains its uncovered tail');
    assert.equal(toOriginal(twins[0].runtimeStart, 1), null, 'erased CommonJS export has no byte-matched runtime-start anchor');
    assert.equal(toOriginal(twins[0].bodyStart), null, 'typed return has no body-start anchor');
    assert.equal(toOriginal.exactDeclarationStart(twins[0].start), original.descriptors[0].start, 'authentic compiler segment binds the whole source AST declaration start');
    assert.equal(toOriginal.exactDeclarationStart(twins[0].start + 1), null, 'nearest segment never owns a shifted declaration start');
    for (const invalid of [[], [...twins, ...twins], twins.map(twin => ({ ...twin, start: twin.start + 1 })), twins.map(twin => ({ ...twin, end: twin.end - 1 }))]) {
      capture.descriptors = invalid;
      assert.match(functionCoverage(original.descriptors[0], [original, generated]).unverified, /missing or ambiguous source-map correspondence/, 'missing, shifted, duplicate or wrong-end native declaration twins refuse');
    }
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});


for (const selected of [0, 1]) {
test('native runtime boundary joins exact ' + ['logical operator', 'finally keyword'][selected] + ' inside its owned body', async () => {
  const source = "export function logical(value: number): boolean {\n  return value > 0\n    && typeof value === 'number';\n}\nexport function cleanup(flag: boolean): number {\n  try {\n    try {\n      if (flag) throw 1;\n      return 2;\n    } catch {\n      return 3;\n    } finally {\n      void flag;\n    }\n  } catch {\n    return 4;\n  }\n}\nlogical(1); logical(0); cleanup(true); cleanup(false);\n";
  const compileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tsc-'));
  let fixture;
  try {
    const output = await nativeTscOutput(compileRoot, source, 'node16');
    fixture = await captureFixture(output, 'cjs');
    fixture.originalPath = path.join(fixture.root, 'original.ts');
    await fs.writeFile(fixture.originalPath, source);
    const scripts = await readCoverage(fixture.coverageDirectory);
    const original = await readOutput(fixture.originalPath, scripts, true, { projectRoot: fixture.root, analyzer });
    const generated = await readOutput(fixture.sourcePath, scripts, false, { projectRoot: fixture.root, analyzer });
    const capture = generated.captures[0];
    const data = JSON.parse(Buffer.from(output.match(/base64,([^\s]+)/)[1], 'base64').toString('utf8'));
    const toOriginal = originalOffsetMapper({ data, lineLengths: output.split('\n').map(line => line.length) }, source, output);
    const metrics = await compilerMetrics(fixture);
    assert.equal(metrics[selected].unverified, undefined, ['logical operator requires authentic owned coverage', 'finally keyword requires authentic owned coverage'][selected]);
    assert.equal(metrics[0].coverage, 1, 'multiline logical operator retains its complete owned UTF-16 denominator');
    assert.equal(metrics[0].unverified, undefined, 'logical operator requires a unique exact owned operand join');
    assert.equal(metrics[1].unverified, undefined, 'finally keyword requires a unique exact owned block join');
    assert.ok(metrics[1].coverage > 0 && metrics[1].coverage < 1, 'uncalled outer catch retains genuinely uncovered owned text');
    for (const [index, descriptor] of original.descriptors.entries()) {
      const twin = capture.descriptors[index];
      const boundary = twin.boundaries[0];
      assert.equal(toOriginal(boundary.start, 1), null, 'native syntax token has no ordinary compiler byte correspondence');
      assert.equal(toOriginal(boundary.anchorStart, 1), descriptor.boundaries[0].anchorStart, 'exact operand or block opening anchors the syntax');
      assert.equal(toOriginal(boundary.anchorEnd - 1, 1), descriptor.boundaries[0].anchorEnd - 1, 'exact operand or block closing anchors the syntax');
      for (const invalid of [[], [...twin.boundaries, ...twin.boundaries], twin.boundaries.map(entry => ({ ...entry, start: entry.start + 1 })), twin.boundaries.map(entry => ({ ...entry, anchorStart: entry.anchorStart + 1 })), capture.descriptors[1 - index].boundaries]) {
        const saved = twin.boundaries;
        twin.boundaries = invalid;
        const result = functionCoverage(descriptor, [original, generated]);
        assert.equal(result.coverage, undefined, 'missing, ambiguous, shifted or wrong-owner syntax cannot acquire coverage');
        assert.match(result.unverified, /runtime coverage boundary/, 'invalid AST correspondence stays unverified');
        twin.boundaries = saved;
      }
    }
    await fs.writeFile(fixture.originalPath, source.replace('value > 0', 'value > 1'));
    assert.ok((await compilerMetrics(fixture)).every(metric => metric.unverified), 'a mismatched embedded original cannot own either boundary');
  } finally {
    await fs.rm(compileRoot, { recursive: true, force: true });
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
}
