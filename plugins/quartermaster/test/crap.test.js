'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { crapReport, crapScore, formatReport } = require('../lib/crap.js');

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

function runCli(argumentsForCommand, projectDir, environment = process.env) {
  return spawnSync(process.execPath, [CLI, 'crap', '--project', projectDir, ...argumentsForCommand], {
    encoding: 'utf8',
    env: environment,
  });
}

function environmentWithoutPath() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^path$/i.test(name)) environment[name] = value;
  }
  environment.PATH = '';
  return environment;
}

function functionNamed(report, name) {
  return report.functions.find((entry) => entry.function === name);
}

test('CRAP comes from the lcov lines inside each function, whatever slashes the lcov used', () => {
  const projectDir = fixtureProject({
    // lizard reports src/sample.js with forward slashes and src\sample.py with backslashes; the lcov
    // below uses the opposite style for each, plus an absolute path, which all have to match anyway.
    'complexity.csv': [
      '4,2,19,2,4,"add@1-4@src/sample.js","src/sample.js","add","add ( a , b )",1,4',
      '9,4,60,1,9,"tangle@6-14@src/sample.js","src/sample.js","tangle","tangle ( n )",6,14',
      '4,2,16,2,4,"add@1-4@src\\sample.py","src\\sample.py","add","add( a , b )",1,4',
      '24,21,213,1,24,"hairy@1-24@src\\hairy.js","src\\hairy.js","hairy","hairy ( n )",1,24',
      '',
    ].join('\n'),
  });
  const lcov = [
    'TN:',
    'SF:src\\sample.js',
    'DA:2,1',
    'DA:3,0',
    'DA:7,1',
    'DA:8,1',
    'DA:9,0',
    'DA:10,0',
    'DA:11,1',
    'DA:13,1',
    'end_of_record',
    `SF:${path.join(projectDir, 'src', 'sample.py').replaceAll('\\', '/')}`,
    'DA:2,1',
    'DA:3,1',
    'DA:4,0',
    'end_of_record',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(projectDir, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'coverage', 'lcov.info'), lcov, 'utf8');

  const report = crapReport({ projectDir, complexity: 'complexity.csv' });

  assert.equal(report.functions.length, 4);
  assert.deepEqual(
    { coverage: functionNamed(report, 'tangle').coverage, crap: functionNamed(report, 'tangle').crap },
    { coverage: 0.6667, crap: 4.59 },
  );
  const javascriptAdd = report.functions.find((entry) => entry.file === 'src/sample.js' && entry.function === 'add');
  assert.deepEqual({ coverage: javascriptAdd.coverage, crap: javascriptAdd.crap }, { coverage: 0.5, crap: 2.5 });
  const pythonAdd = report.functions.find((entry) => entry.file === 'src/sample.py');
  assert.deepEqual({ coverage: pythonAdd.coverage, crap: pythonAdd.crap }, { coverage: 0.6667, crap: 2.15 });
  assert.equal(crapScore(2, 2 / 3), pythonAdd.cc ** 2 * (1 - 2 / 3) ** 3 + pythonAdd.cc);

  const hairy = functionNamed(report, 'hairy');
  assert.deepEqual({ coverage: hairy.coverage, crap: hairy.crap, unmeasured: hairy.unmeasured }, { coverage: 0, crap: 462, unmeasured: true });
  assert.equal(report.unmeasured, 1);

  assert.deepEqual(report.failures.map((entry) => `${entry.function}:${entry.reason}`), ['hairy:ceiling']);
  assert.equal(report.max, 6);
  assert.equal(
    formatReport(report),
    'src/hairy.js:1 hairy cc=21 coverage=0% CRAP=462\nCRAP gate failed: 1 of 4 functions at or above 6\n',
  );
});

test('a raised ceiling passes the same functions', () => {
  const projectDir = fixtureProject({
    'complexity.csv': '24,21,213,1,24,"hairy@1-24@a.js","a.js","hairy","hairy ( n )",1,24\n',
    'coverage/lcov.info': 'SF:a.js\nDA:2,1\nend_of_record\n',
  });
  const report = crapReport({ projectDir, complexity: 'complexity.csv', max: 500 });
  assert.deepEqual(report.failures, []);
  assert.equal(report.atOrAboveMax, 0);
  assert.equal(formatReport(report), 'CRAP gate passed: 0 of 1 functions at or above 500\n');
});

test('the ratchet fails a function that got worse and holds new functions to the ceiling', () => {
  const projectDir = fixtureProject({
    'src/app.js': [
      'function existing(n) {',
      '  if (n > 0) return 1;',
      '  if (n < 0) return -1;',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    'src/untouched.js': 'function legacy(n) {\n  return n;\n}\n',
    'coverage/lcov.info': 'SF:src/app.js\nDA:2,1\nDA:3,0\nend_of_record\n',
  });
  const git = (args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'app.js'),
    [
      'function existing(n) {',
      '  if (n > 0) return 1;',
      '  if (n < 0) return -1;',
      '  if (n === 0) return 0;',
      '  return NaN;',
      '}',
      '',
      'function fresh(n) {',
      '  return n;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const currentCsv = [
    '6,5,40,1,6,"existing@1-6@src/app.js","src/app.js","existing","existing ( n )",1,6',
    '12,9,80,1,12,"fresh@8-19@src/app.js","src/app.js","fresh","fresh ( n )",8,19',
    '10,7,70,1,10,"legacy@1-10@src/untouched.js","src/untouched.js","legacy","legacy ( n )",1,10',
    '',
  ].join('\n');
  const baseCsv = '6,3,30,1,6,"existing@1-6@./src/app.js","./src/app.js","existing","existing ( n )",1,6\n';
  const lizardCalls = [];
  const runLizard = ({ cwd, sources }) => {
    lizardCalls.push({ cwd, sources });
    return path.resolve(cwd) === path.resolve(projectDir) ? currentCsv : baseCsv;
  };

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.equal(lizardCalls.length, 2, 'the baseline needs its own lizard run');
  const worsened = report.failures.find((entry) => entry.function === 'existing');
  assert.deepEqual(
    { reason: worsened.reason, cc: worsened.cc, baselineCc: worsened.baselineCc, crap: worsened.crap, baselineCrap: worsened.baselineCrap },
    { reason: 'ratchet', cc: 5, baselineCc: 3, crap: 8.13, baselineCrap: 4.13 },
  );
  const added = report.failures.find((entry) => entry.function === 'fresh');
  assert.deepEqual({ reason: added.reason, crap: added.crap, unmeasured: added.unmeasured }, { reason: 'ceiling', crap: 90, unmeasured: true });
  assert.equal(report.failures.length, 2);
  assert.equal(report.failures.some((entry) => entry.function === 'legacy'), false, 'an unchanged file is not gated');
  assert.equal(report.atOrAboveMax, 1);
  assert.equal(report.preExistingAtOrAboveMax, 2);
  assert.match(formatReport(report), /CRAP gate failed: 1 of 3 functions at or above 6; 2 pre-existing functions at or above 6 \(ratchet against main\)/);
});

test('the config file supplies the gate settings and flags override it', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ lcov: 'reports/lcov.info', max: 100 }),
    'complexity.csv': '24,21,213,1,24,"hairy@1-24@a.js","a.js","hairy","hairy ( n )",1,24\n',
    'reports/lcov.info': 'SF:a.js\nDA:2,1\nend_of_record\n',
  });
  assert.equal(crapReport({ projectDir, complexity: 'complexity.csv' }).failures.length, 0);
  assert.equal(crapReport({ projectDir, complexity: 'complexity.csv', max: 6 }).failures.length, 1);
});

test('a missing lcov file exits 2 with the fix, not a passing gate', () => {
  const projectDir = fixtureProject({ 'complexity.csv': '' });
  const result = runCli(['--complexity', 'complexity.csv'], projectDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no lcov coverage at/);
  assert.match(result.stderr, /run your coverage command first/);
  assert.equal(result.stdout, '');
});

test('an unresolvable lizard exits 2 with the install hint', () => {
  const projectDir = fixtureProject({ 'coverage/lcov.info': 'SF:a.js\nDA:2,1\nend_of_record\n' });
  const result = runCli([], projectDir, environmentWithoutPath());
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /lizard is not resolvable \(tried lizard, uvx lizard, pipx run lizard\)/);
  assert.match(result.stderr, /uv tool install lizard/);
});

test('a failing coverage command exits 2 instead of reading a stale lcov', () => {
  const projectDir = fixtureProject({
    'complexity.csv': '',
    'coverage/lcov.info': 'SF:a.js\nDA:2,1\nend_of_record\n',
  });
  const result = runCli(['--complexity', 'complexity.csv', '--coverage-command', 'node -e "process.exit(3)"'], projectDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /coverage command exited 3/);
});

test('the real lizard backend measures a JavaScript and a Python file end to end', (t) => {
  const probe = spawnSync('uvx', ['lizard', '--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('lizard does not resolve here (no uvx lizard)');
    return;
  }
  const projectDir = fixtureProject({
    'src/sample.js': [
      'function add(a, b) {',
      '  if (a > b) return a;',
      '  return b;',
      '}',
      '',
    ].join('\n'),
    'src/sample.py': 'def add(a, b):\n    if a > b:\n        return a\n    return b\n',
    'coverage/lcov.info': 'SF:src/sample.js\nDA:2,1\nDA:3,0\nend_of_record\nSF:src/sample.py\nDA:2,1\nDA:3,1\nDA:4,0\nend_of_record\n',
  });
  const result = runCli(['--json'], projectDir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.functions.map((entry) => `${entry.file} cc=${entry.cc} crap=${entry.crap}`).sort(),
    ['src/sample.js cc=2 crap=2.5', 'src/sample.py cc=2 crap=2.15'],
  );
  assert.equal(report.unmeasured, 0);
});
