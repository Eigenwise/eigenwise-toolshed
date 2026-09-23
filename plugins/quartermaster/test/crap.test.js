'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { crapReport, crapScore, formatReport, PrerequisiteError } = require('../lib/crap.js');

const CLI = path.resolve(__dirname, '../bin/quartermaster.js');

function fixtureProject(files) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
  return projectDir;
}

function commitBase(projectDir) {
  const git = (argumentsForGit) => execFileSync('git', argumentsForGit, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);
}

function runCli(argumentsForCommand, projectDir, environment = process.env) {
  return spawnSync(process.execPath, [CLI, 'crap', '--project', projectDir, ...argumentsForCommand], { encoding: 'utf8', env: environment });
}

function csv(entries) {
  return `${entries.map(({ complexity, name, start, end }) => `${end - start + 1},${complexity},10,1,${end - start + 1},"${name}@${start}-${end}@src/app.js","src/app.js","${name}","${name} ()",${start},${end}`).join('\n')}\n`;
}

function lcov(lines) {
  return `SF:src/app.js\n${lines.map(([line, hits]) => `DA:${line},${hits}`).join('\n')}\nend_of_record\n`;
}

function runner(current, base) {
  return ({ cwd }) => (path.basename(cwd).startsWith('quartermaster-crap-base-') ? base : current);
}

test('gates only new or modified functions at the strict threshold', () => {
  const projectDir = fixtureProject({
    'src/app.js': [
      'function unchanged(value) { return value; }',
      'function lowered(value) { if (value) return value; return 0; }',
      'function existing(value) { return value; }',
      '',
    ].join('\n'),
    'coverage/lcov.info': lcov([[1, 1], [2, 1], [3, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), [
    'function unchanged(value) { return value; }',
    'function lowered(value) { return value; }',
    'function existing(value) { if (value) return value; return 0; }',
    'function run(value) { if (value > 3) return 1; if (value > 2) return 2; if (value > 1) return 3; if (value > 0) return 4; return 0; }',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'coverage/lcov.info'), lcov([[1, 1], [2, 1], [3, 1], [4, 1]]), 'utf8');

  const report = crapReport({
    projectDir,
    ratchet: 'main',
    runLizard: runner(
      csv([{ complexity: 8, name: 'unchanged', start: 1, end: 1 }, { complexity: 2, name: 'lowered', start: 2, end: 2 }, { complexity: 3, name: 'existing', start: 3, end: 3 }, { complexity: 6, name: 'run', start: 4, end: 4 }]),
      csv([{ complexity: 8, name: 'unchanged', start: 1, end: 1 }, { complexity: 7, name: 'lowered', start: 2, end: 2 }, { complexity: 1, name: 'existing', start: 3, end: 3 }]),
    ),
  });

  assert.deepEqual(report.failures.map((entry) => entry.function), ['run']);
  assert.equal(report.checked, 3);
  assert.equal(formatReport(report), 'src/app.js:4 run cc=6 coverage=100% CRAP=6\nCRAP gate failed: 1 of 3 changed or new functions at or above 6\n');
});

test('accepts a modified function whose score falls below six', () => {
  const projectDir = fixtureProject({
    'src/app.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), 'function subject(value) { if (value) return value; return 0; }\n', 'utf8');
  const report = crapReport({
    projectDir,
    ratchet: 'main',
    runLizard: runner(csv([{ complexity: 3, name: 'subject', start: 1, end: 1 }]), csv([{ complexity: 2, name: 'subject', start: 1, end: 1 }])),
  });
  assert.deepEqual(report.failures, []);
  assert.equal(formatReport(report), 'CRAP gate passed: 0 of 1 changed or new functions at or above 6\n');
});

test('rejects a configured ceiling other than six', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ max: 7 }),
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  assert.throws(() => crapReport({ projectDir, complexity: 'empty.csv' }), /threshold is fixed at 6/);
});

test('reports zero lizard functions for changed code as unverified', () => {
  const projectDir = fixtureProject({
    'src/app.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), 'function subject(value) { return value + 1; }\n', 'utf8');
  assert.throws(
    () => crapReport({ projectDir, ratchet: 'main', runLizard: () => '' }),
    (error) => error instanceof PrerequisiteError && /lizard reported zero functions for src\/app\.js/.test(error.message),
  );
});

test('reports missing changed-function coverage as unverified', () => {
  const projectDir = fixtureProject({
    'src/app.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), 'function subject(value) { return value + 1; }\n', 'utf8');
  assert.throws(
    () => crapReport({ projectDir, ratchet: 'main', runLizard: runner(csv([{ complexity: 1, name: 'subject', start: 1, end: 1 }]), csv([{ complexity: 1, name: 'subject', start: 1, end: 1 }])) }),
    (error) => error instanceof PrerequisiteError && /coverage is unverified for src\/app\.js:1 subject/.test(error.message),
  );
});

test('honors a configured exclude for the only changed file, avoiding an unmeasured failure', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ exclude: ['**/*.test.*'] }),
    'app.test.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'app.test.js'), 'function subject(value) { if (value) return value; return 0; }\n', 'utf8');
  const report = crapReport({ projectDir, ratchet: 'main', runLizard: () => csv([]) });
  assert.deepEqual(report.failures, []);
  assert.equal(report.checked, 0);
});

test('a changed file that does not match the config exclude stays fail-closed when lizard finds nothing', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ exclude: ['**/*.test.*'] }),
    'src/app.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), 'function subject(value) { return value + 1; }\n', 'utf8');
  assert.throws(
    () => crapReport({ projectDir, ratchet: 'main', runLizard: () => '' }),
    (error) => error instanceof PrerequisiteError && /lizard reported zero functions for src\/app\.js/.test(error.message),
  );
});

test('honors a configured directory exclude pattern the same way as a file pattern', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ exclude: ['dist/**'] }),
    'dist/bundle.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'dist/bundle.js'), 'function subject(value) { if (value) return value; return 0; }\n', 'utf8');
  const report = crapReport({ projectDir, ratchet: 'main', runLizard: () => csv([]) });
  assert.deepEqual(report.failures, []);
  assert.equal(report.checked, 0);
});

test('a missing lcov file exits two with the fix, not a passing gate', () => {
  const projectDir = fixtureProject({ 'complexity.csv': '' });
  const result = runCli(['--complexity', 'complexity.csv'], projectDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no lcov coverage at/);
  assert.match(result.stderr, /run your coverage command first/);
});

test('an unresolvable lizard exits two with the install hint', () => {
  const projectDir = fixtureProject({ 'coverage/lcov.info': 'SF:a.js\nDA:2,1\nend_of_record\n' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^path$/i.test(name)));
  environment.PATH = '';
  const result = runCli([], projectDir, environment);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /lizard is not resolvable/);
  assert.match(result.stderr, /uv tool install lizard/);
});

test('the real lizard backend measures a changed JavaScript file end to end', () => {
  const probe = spawnSync('lizard', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return;
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ base: 'main', sources: ['src'] }),
    'src/app.js': 'function add(left, right) { return left + right; }\n',
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/app.js'), 'function add(left, right) { if (left > right) return left; return right; }\n', 'utf8');
  const result = runCli(['--json'], projectDir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checked, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(crapScore(2, 1), 2);
});
