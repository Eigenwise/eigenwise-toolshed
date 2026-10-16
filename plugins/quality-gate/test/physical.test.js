import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { crapReport } from '../lib/crap.mjs';
import { createAnalyzer, changedMetricsAgainstBase } from '../lib/core.mjs';
import { lizardDescriptors } from '../lib/lizard.mjs';
import { fileURLToPath } from 'node:url';
import { measureFiles } from '../lib/measure.mjs';

const javascriptBody = `function subject(value) {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  return 0;
}
`;
const pythonBody = `def subject(value):
    if value == 1: return 1
    if value == 2: return 2
    if value == 3: return 3
    if value == 4: return 4
    if value == 5: return 5
    return 0
`;
const languages = [
  { extension: 'js', body: javascriptBody, extra: '  if (value === 6) return 6;\n', end: '  return 0;', comparison: 'value === 1', formatted: 'value  ===  1', comment: '  // physical edit\n', nested: 'function outer() { const child = (value) => value; return child; }\n', nestedEdit: '(value) => (value + 1)', nestedOriginal: '(value) => value', child: 'child' },
  { extension: 'ts', body: javascriptBody, extra: '  if (value === 6) return 6;\n', end: '  return 0;', comparison: 'value === 1', formatted: 'value  ===  1', comment: '  // physical edit\n', nested: 'function outer() { const child = (value) => value; return child; }\n', nestedEdit: '(value) => (value + 1)', nestedOriginal: '(value) => value', child: 'child' },
  { extension: 'py', body: pythonBody, extra: '    if value == 6: return 6\n', end: '    return 0', comparison: 'value == 1', formatted: 'value  ==  1', comment: '    # physical edit\n', nested: 'def outer():\n    note = "雪"\n    @decorate\n    def child(value):\n        return value\n    return child\n', nestedEdit: 'return value + 1', nestedOriginal: 'return value', child: 'outer.child' },
];

function git(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function project(context, extension, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-physical-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = `subject.${extension}`;
  await fs.mkdir(path.join(root, '.claude/quality-gate'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude/quality-gate/crap.json'), JSON.stringify({ sources: [file] }));
  await fs.writeFile(path.join(root, file), text);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  return { root, file, base: git(root, ['rev-parse', 'HEAD']) };
}

for (const language of languages) {
  test(`${language.extension} exact physical ownership controls`, async (context) => {
    const higher = language.body.replace('subject', 'higher').replace(language.end, language.extra + language.end);
    const original = language.body + higher + language.nested;
    const { root, file, base } = await project(context, language.extension, original);
    const cases = [
      { label: 'inter-function comment never changes an owned body', text: original.replace(higher, language.comment.trim() + '\n' + higher), names: [], failures: [] },
      { label: 'trailing inline comment belongs to its body', text: original.replace(language.end, language.end + language.comment.trim()), names: ['subject'], failures: [] },
      { label: 'comment-only legacy CC6 is informational; untouched CC6 is excluded', text: original.replace(language.end, language.comment + language.end), names: ['subject'], failures: [] },
      { label: 'formatting-only legacy CC6 is informational', text: original.replace(language.comparison, language.formatted), names: ['subject'], failures: [] },
      { label: 'lowered-but-still-CC6 is informational', text: original.replace(language.extra, ''), names: ['higher'], failures: [] },
      { label: 'nested-only physical edit leaves parent unchanged', text: original.replace(language.nestedOriginal, language.nestedEdit), names: [language.child], failures: [] },
      { label: 'deleted body leaves no changed surviving body', text: higher + language.nested, names: [], failures: [] },
      { label: 'unchanged bodies leave nothing to score', text: original, names: [], failures: [] },
    ];
    for (const scenario of cases) {
      await context.test(scenario.label, async () => {
        await fs.writeFile(path.join(root, file), scenario.text);
        const report = await crapReport({ project: root, base, ccOnly: true });
        assert.deepEqual(report.changedMetrics.map((row) => row.name), scenario.names);
        assert.deepEqual(report.failures.map((row) => row.name), scenario.failures);
        assert.deepEqual(report.changedMetrics.map((row) => row.classification), scenario.names.map(() => 'legacy-unchanged'));
        assert.equal(report.checked, 0);
        assert.equal(report.exitCode, Number(scenario.failures.length > 0));
      });
    }
  });
}

for (const extension of ['php', 'vue']) {
  test(extension + ' physical formatting excludes an untouched Lizard body', async () => {
    const analyzer = await createAnalyzer(fileURLToPath(new URL('../', import.meta.url)));
    const bodies = 'function subject(value) { return value; }\nfunction untouched(value) { return value; }\n';
    const source = extension === 'php' ? '<?php\n' + bodies.replaceAll('value', '$value') : '<script>\n' + bodies + '</script>\n';
    const file = 'subject.' + extension;
    const csv = '1,6,1,1,1,subject,' + file + ',subject,subject,2,2\n1,6,1,1,1,untouched,' + file + ',untouched,untouched,3,3\n';
    const baseline = await lizardDescriptors(source, file, analyzer, csv);
    const descriptors = await lizardDescriptors(source.replace('return ', 'return  '), file, analyzer, csv);
    const changed = await changedMetricsAgainstBase(descriptors.map((row) => ({ ...row, relativePath: file })), [file], 'base', async () => baseline);
    assert.deepEqual(changed.map((row) => row.name), ['subject']);
    assert.equal(changed[0].classification, 'legacy-unchanged');
    const overlapping = await lizardDescriptors(source, file, analyzer, csv.replace('subject,2,2', 'subject,2,3'));
    assert.ok(overlapping.every((row) => row.unverified.includes('independent body ownership')));
  });
}

test('Python trailing indented comments belong to the child, dedented comments stay outside', async (context) => {
  const original = 'def outer():\n    @(\n        decorate\n    )\n    def child(value):\n        return value\n        # child note\n\n    # outer note\n    return child\n\n# between\n\ndef untouched():\n    return 1\n';
  const { root, file, base } = await project(context, 'py', original);
  for (const [before, after, names] of [
    ['# child note', '# child changed', ['outer.child']],
    ['@(\n', '@( \n', ['outer.child']],
    ['# outer note', '# outer changed', ['outer']],
    ['# between', '# between changed', []],
  ]) {
    await fs.writeFile(path.join(root, file), original.replace(before, after));
    const report = await crapReport({ project: root, base, ccOnly: true });
    assert.deepEqual(report.changedMetrics.map((row) => row.name), names);
  }
});

test('comment-only and formatting-only legacy CC6 are informational with genuine complete same-session V8 coverage', async (context) => {
  const original = javascriptBody + 'for (let value = 0; value <= 5; value += 1) subject(value);\n';
  const { root, file, base } = await project(context, 'js', original);
  for (const [label, text] of [
    ['comment', original.replace('  return 0;', '  // physical edit\n  return 0;')],
    ['formatting', original.replace('value === 1', 'value  ===  1')],
  ]) {
    await fs.writeFile(path.join(root, file), text);
    const coverageDirectory = path.join(root, label);
    await fs.mkdir(coverageDirectory);
    assert.deepEqual(await fs.readdir(coverageDirectory), []);
    const execution = spawnSync(process.execPath, ['--import', new URL('../lib/core.mjs', import.meta.url).href, path.join(root, file)], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, QUALITY_GATE_V8_CAPTURE: coverageDirectory } });
    assert.equal(execution.status, 0, execution.stderr);
    const report = await measureFiles([file], { projectRoot: root, base, coverageDirectory });
    assert.deepEqual(report.changedMetrics.map((row) => row.name), ['subject']);
    assert.equal(report.changedMetrics[0].classification, 'legacy-unchanged');
    assert.equal(report.changedMetrics[0].coverage, 1);
    assert.equal(report.changedMetrics[0].crap, 6);
    assert.equal(report.failures.length, 0);
  }
});

for (const fixture of [
  { label: 'lambda-decorated nested class', body: '    @(lambda decorated: decorated)\n    class Local:\n        def child(self):\n            return 1\n', before: '            return 1', after: '            return 2', child: 'outer.Local.child', identity: '<root>/FunctionDef:outer#0/FunctionDef:outer.Local.child#0' },
  { label: 'interleaved dictionary lambdas', body: '    callbacks = {\n        (lambda: 1): (lambda: 2),\n        (lambda: 3): (lambda: 4),\n    }\n', before: 'lambda: 3', after: 'lambda: 5', child: 'outer.<lambda>', identity: '<root>/FunctionDef:outer#0/Lambda:outer.<lambda>#1' },
]) {
  test('Python source-ordered ownership: ' + fixture.label, async (context) => {
    const original = pythonBody.replace('subject', 'outer').replace('    return 0', fixture.body + '    return 0');
    const { root, file, base } = await project(context, 'py', original);
    const baseline = await crapReport({ project: root, base: 'HEAD', ccOnly: true });
    assert.equal(baseline.metrics[0].complexity, 6);
    for (const scenario of [
      { label: 'child-only edit preserves outer fingerprint and excludes legacy CC6 parent', text: original.replace(fixture.before, fixture.after), identity: fixture.identity, name: fixture.child, failures: [] },
      { label: 'parent-owned edit selects informational CC6 parent', text: original.replace('    return 0', '    # parent-owned edit\n    return 0'), identity: '<root>/FunctionDef:outer#0', name: 'outer', failures: [] },
    ]) {
      await context.test(scenario.label, async () => {
        await fs.writeFile(path.join(root, file), scenario.text);
        const report = await crapReport({ project: root, base, ccOnly: true });
        assert.deepEqual(report.metrics.filter((row, index) => row.fingerprint !== baseline.metrics[index].fingerprint).map((row) => row.identity), [scenario.identity], 'only independently edited body fingerprints change');
        assert.deepEqual(report.changedMetrics.map((row) => row.identity), [scenario.identity], 'only independently edited bodies enter changed rows');
        assert.deepEqual(report.changedMetrics.map((row) => row.name), [scenario.name]);
        assert.deepEqual(report.failures.map((row) => row.name), scenario.failures, 'untouched legacy parent is excluded; equal-complexity parent edits are informational');
        assert.equal(report.checked, 0);
        assert.equal(report.exitCode, scenario.failures.length);
      });
    }
  });
}
