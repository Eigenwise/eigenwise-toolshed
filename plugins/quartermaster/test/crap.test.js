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

/** The gate resolves lizard itself; skip only when none of the three ways to reach it works here. */
function lizardResolves() {
  for (const [command, leading] of [['lizard', []], ['uvx', ['lizard']], ['pipx', ['run', 'lizard']]]) {
    const probe = spawnSync(command, [...leading, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return true;
  }
  return false;
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

test('a .tsx tag lizard gives up on cannot invent complexity, or hide the function it swallowed', (t) => {
  if (!lizardResolves()) {
    t.skip('lizard does not resolve here');
    return;
  }
  // lizard's own TSX reader reads this fixture as one SaleField spanning lines 16-33 at cc=3 and never
  // reports SaleTotals at all. The hand counts in the fixture are SaleField 1, packsLabel 2, SaleTotals 3.
  const projectDir = fs.realpathSync.native(
    fixtureProject({
      'src/sale.tsx': fs.readFileSync(path.join(__dirname, 'fixtures', 'jsx-phantom-complexity.tsx'), 'utf8'),
      'coverage/lcov.info': 'SF:src/sale.tsx\nDA:17,1\nDA:28,0\nend_of_record\n',
    }),
  );

  const result = runCli(['--json', '--max', '20'], projectDir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.functions.map((entry) => `${entry.function}@${entry.line} cc=${entry.cc} ${entry.source}`).sort(),
    [
      'SaleField@16 cc=1 lizard-typescript',
      'SaleTotals@27 cc=3 lizard-typescript',
      'packsLabel@25 cc=2 lizard-typescript',
    ],
  );

  const gated = runCli(['--max', '2'], projectDir);
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stdout, /^src\/sale\.tsx:27 SaleTotals cc=3 coverage=0% CRAP=12 source=lizard-typescript$/m);
});

test('the TypeScript reader measures the real .tsx bytes, under a name that only picks the reader', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'jsx-phantom-complexity.tsx'), 'utf8');
  const projectDir = fs.realpathSync.native(
    fixtureProject({ 'src/sale.tsx': source, 'coverage/lcov.info': 'SF:src/sale.tsx\nDA:17,1\nend_of_record\n' }),
  );
  const copies = [];
  const runLizard = ({ cwd }) => {
    if (path.resolve(cwd) === path.resolve(projectDir)) {
      return '5,3,40,1,18,"SaleField@16-33@./src/sale.tsx","./src/sale.tsx","SaleField","SaleField ( props )",16,33\n';
    }
    // The scratch tree is gone by the time crapReport returns, so read it while lizard would have.
    copies.push({ names: fs.readdirSync(path.join(cwd, 'src')), text: fs.readFileSync(path.join(cwd, 'src', 'sale.ts'), 'utf8') });
    return '5,1,40,1,5,"SaleField@16-20@./src/sale.ts","./src/sale.ts","SaleField","SaleField ( props )",16,20\n';
  };

  const report = crapReport({ projectDir, runLizard });

  assert.deepEqual(copies.map((copy) => copy.names), [['sale.ts']], 'the copy is named for the reader, not rewritten in place');
  assert.equal(copies[0].text, source, 'the copy is the real file byte for byte');
  assert.deepEqual(
    report.functions.map((entry) => `${entry.file}:${entry.line} cc=${entry.cc} ${entry.source}`),
    ['src/sale.tsx:16 cc=1 lizard-typescript'],
    'the row comes back under the real .tsx path',
  );
});

test('the ratchet reads both sides of a .tsx through the same reader', () => {
  const projectDir = fs.realpathSync.native(
    fixtureProject({
      'src/sale.tsx': 'const SaleField = () => <input className={a} data-testid="x" />;\n',
      'coverage/lcov.info': 'SF:src/sale.tsx\nDA:1,1\nend_of_record\n',
    }),
  );
  const git = (args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  fs.writeFileSync(
    path.join(projectDir, 'src', 'sale.tsx'),
    'const SaleField = (a: boolean) => <input className={a} data-testid={a ? "x" : "y"} />;\n',
    'utf8',
  );

  const seen = [];
  const runLizard = ({ cwd }) => {
    if (path.resolve(cwd) === path.resolve(projectDir)) {
      return '1,9,40,1,1,"SaleField@1-1@./src/sale.tsx","./src/sale.tsx","SaleField","SaleField ( )",1,1\n';
    }
    seen.push(fs.readFileSync(path.join(cwd, 'src', 'sale.ts'), 'utf8'));
    return seen.length === 1
      ? '1,3,40,1,1,"SaleField@1-1@./src/sale.ts","./src/sale.ts","SaleField","SaleField ( )",1,1\n'
      : '1,2,40,1,1,"SaleField@1-1@./src/sale.ts","./src/sale.ts","SaleField","SaleField ( )",1,1\n';
  };

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.equal(seen.length, 2, 'the working tree and the baseline each get a TypeScript-reader copy');
  assert.match(seen[0], /a \? "x" : "y"/, 'the first copy is the working tree');
  assert.match(seen[1], /data-testid="x"/, 'the second copy is the committed baseline');
  assert.deepEqual(
    report.failures.map((entry) => `${entry.file} ${entry.reason} cc=${entry.cc} baselineCc=${entry.baselineCc} ${entry.source}`),
    ['src/sale.tsx ratchet cc=3 baselineCc=2 lizard-typescript'],
    'the baseline row pairs with the working-tree row under the real .tsx path',
  );
});
