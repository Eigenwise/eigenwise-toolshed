'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { COVERAGE_DIR_ENV, crapReport, crapScore, formatReport, realDir, sameDir } = require('../lib/crap.js');

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

/**
 * crapReport passes runLizard a workDir resolved through git, which realpath-normalizes 8.3 short names
 * and symlinks; comparing raw path.resolve() output against the fixture's own un-normalized temp path
 * would spuriously disagree on Windows even though both name the same directory.
 */
function sameRealDir(left, right) {
  return sameDir(realDir(left), realDir(right));
}

/**
 * The three ratchet tests below feed a fake `runLizard` that must tell a "current" cwd (the project
 * itself) from a "baseline" cwd (the temp checkout `baselineFunctions()` makes via
 * `quartermaster-crap-base-*`). A `sameRealDir` regression that stops recognizing the project would
 * previously fall through silently to the baseline branch and produce a confusing TypeError or a
 * quietly-wrong 0-failure report; this makes that mismatch a loud AssertionError naming both spellings.
 */
function classifyRatchetCwd(cwd, projectDir) {
  if (sameRealDir(cwd, projectDir)) return 'current';
  if (path.basename(cwd).startsWith('quartermaster-crap-base-')) return 'baseline';
  assert.fail(`fake runLizard got an unrecognized cwd ${cwd}; expected the project ${projectDir} or a quartermaster-crap-base- baseline checkout`);
}

test('sameRealDir resolves a symlinked alias the way native realpath does, unlike plain realpathSync', () => {
  // Reproduces the Windows 8.3-short-name gap on Linux: a symlink alias stands in for the short form,
  // and the non-native realpathSync is stubbed to leave its input unresolved, the way the non-native
  // realpath leaves 8.3 short names unexpanded on Windows.
  const realDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-real-'));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-alias-'));
  const aliasDirPath = path.join(aliasParent, 'alias');
  fs.symlinkSync(realDirPath, aliasDirPath, 'dir');

  const originalRealpathSync = fs.realpathSync;
  const stubbedRealpathSync = (target) => target;
  stubbedRealpathSync.native = originalRealpathSync.native;
  fs.realpathSync = stubbedRealpathSync;
  try {
    assert.equal(fs.realpathSync(aliasDirPath), aliasDirPath, 'the stub leaves the alias unresolved, mimicking an unexpanded 8.3 short name');
    assert.ok(
      sameRealDir(aliasDirPath, realDirPath),
      'sameRealDir must resolve through realpathSync.native, which still dereferences the symlink despite the stub',
    );
  } finally {
    fs.realpathSync = originalRealpathSync;
  }
});

function rounded2(value) {
  return Number(value.toFixed(2));
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
    return classifyRatchetCwd(cwd, projectDir) === 'current' ? currentCsv : baseCsv;
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

/**
 * The file aggregate is reported but no longer decides: here it holds (worst complexity 20 -> 15) and
 * the rewritten component is still gated, because one-to-one pairing left it without a baseline row.
 */
test('a rewritten anonymous function that also moved answers to the ceiling, whatever the file aggregate did', () => {
  const projectDir = fixtureProject({
    'src/widget.js': [
      'const Widget = (props) => {',
      '  if (props.a) return 1;',
      '  if (props.b) return 2;',
      '  if (props.c) return 3;',
      '  if (props.d) return 4;',
      '  return 0;',
      '};',
      '',
    ].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  // lizard reports every one of these as "(anonymous)"; extracting two helpers ahead of the component
  // shifts its position among same-named siblings, and its own body was rewritten to call them.
  fs.writeFileSync(
    path.join(projectDir, 'src', 'widget.js'),
    [
      'const helperA = (x) => {',
      '  return x + 1;',
      '};',
      '',
      'const helperB = (x) => {',
      '  return x - 1;',
      '};',
      '',
      'const Widget = (props) => {',
      '  if (props.a) return helperA(1);',
      '  return helperB(0);',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  const baseCsv = '20,20,100,1,7,"(anonymous)@1-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,7\n';
  const currentCsv = [
    '1,1,10,1,3,"(anonymous)@1-3@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,3',
    '1,1,10,1,3,"(anonymous)@5-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",5,7',
    '15,15,80,1,4,"(anonymous)@9-12@src/widget.js","src/widget.js","(anonymous)","(anonymous)",9,12',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures.map((entry) => `${entry.line}:${entry.reason}:crap=${entry.crap}`), ['9:ceiling:crap=240']);
  assert.equal(report.ambiguousMatches.length, 1);
  assert.deepEqual(
    { file: report.ambiguousMatches[0].file, degraded: report.ambiguousMatches[0].degraded },
    { file: 'src/widget.js', degraded: false },
    'the aggregate held and is still reported; it is not what decided the unmatched function',
  );
  assert.match(formatReport(report), /src\/widget\.js: ambiguous match/);
  assert.doesNotMatch(formatReport(report), /CRAP gate passed/);
});

/**
 * The same shape with the component's text untouched: exact source text claims its own baseline row
 * before the two inserted helpers can take it by position, so nothing is reported as new.
 */
test('an anonymous function whose text is untouched keeps its own baseline when neighbours shift its position', () => {
  const widget = [
    'const Widget = (props) => {',
    '  if (props.a) return 1;',
    '  if (props.b) return 2;',
    '  if (props.c) return 3;',
    '  if (props.d) return 4;',
    '  return 0;',
    '};',
  ];
  const projectDir = fixtureProject({
    'src/widget.js': [...widget, ''].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'widget.js'),
    ['const helperA = (x) => {', '  return x + 1;', '};', '', 'const helperB = (x) => {', '  return x - 1;', '};', '', ...widget, ''].join('\n'),
    'utf8',
  );

  const baseCsv = '20,20,100,1,7,"(anonymous)@1-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,7\n';
  const currentCsv = [
    '1,1,10,1,3,"(anonymous)@1-3@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,3',
    '1,1,10,1,3,"(anonymous)@5-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",5,7',
    '20,20,100,1,7,"(anonymous)@9-15@src/widget.js","src/widget.js","(anonymous)","(anonymous)",9,15',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures, [], 'the untouched component matched its own baseline row by exact text');
  assert.deepEqual(report.ambiguousMatches, []);
  assert.equal(report.preExistingAtOrAboveMax, 1);
  assert.match(formatReport(report), /CRAP gate passed: 0 of 3 functions at or above 6/);
});

test('an anonymous function that truly gets worse still reports one new offender, with no stable baseline match', () => {
  const projectDir = fixtureProject({
    'src/widget.js': [
      'const Widget = (props) => {',
      '  if (props.a) return 1;',
      '  if (props.b) return 2;',
      '  if (props.c) return 3;',
      '  if (props.d) return 4;',
      '  return 0;',
      '};',
      '',
    ].join('\n'),
    'coverage/lcov.info': '',
  });
  const git = (args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'widget.js'),
    [
      'const helperA = (x) => {',
      '  return x + 1;',
      '};',
      '',
      'const helperB = (x) => {',
      '  return x - 1;',
      '};',
      '',
      'const Widget = (props) => {',
      '  if (props.a) return helperA(1);',
      '  if (props.b) return helperB(0);',
      '  if (props.c) return helperA(2) + helperB(3);',
      '  return 0;',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  const baseCsv = '20,20,100,1,7,"(anonymous)@1-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,7\n';
  const currentCsv = [
    '1,1,10,1,3,"(anonymous)@1-3@src/widget.js","src/widget.js","(anonymous)","(anonymous)",1,3',
    '1,1,10,1,3,"(anonymous)@5-7@src/widget.js","src/widget.js","(anonymous)","(anonymous)",5,7',
    '25,25,120,1,6,"(anonymous)@9-14@src/widget.js","src/widget.js","(anonymous)","(anonymous)",9,14',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (classifyRatchetCwd(cwd, projectDir) === 'current' ? currentCsv : baseCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.equal(report.failures.length, 1);
  assert.deepEqual(
    { line: report.failures[0].line, reason: report.failures[0].reason },
    { line: 9, reason: 'ceiling' },
  );
  assert.equal(report.ambiguousMatches[0].degraded, true, 'the aggregate agrees here, but the ceiling is what gated the function');
  assert.match(formatReport(report), /CRAP gate failed: 1 of 3 functions/);
});

/** The baseline checkout is the only cwd `baselineFunctions()` ever makes, and it names itself. */
function isBaselineCwd(cwd) {
  return path.basename(cwd).startsWith('quartermaster-crap-base-');
}

function initFixtureRepository(projectDir) {
  const git = (args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);
}

/**
 * Inserting one function shifts the position of every later function that shares its name, and lizard
 * repeats names freely: two Python classes with a `run`, two components with a `render`. Pairing on
 * position alone read the untouched namesakes against the wrong baseline row, so one came back as a
 * regression (its own 13 branches against its neighbour's baseline 4) and the one pushed past the end of
 * the baseline's ordinals came back as a new function over the ceiling.
 */
test('inserting a same-named function leaves its untouched namesakes matched to their own baseline', () => {
  const alphaRun = ['    def run(self, n):', '        if n > 0:', '            return 1', '        return 0'];
  const betaRun = ['    def run(self, n):', '        if n < 0:', '            return -1', '        return 0'];
  const projectDir = fixtureProject({
    'src/jobs.py': ['class Alpha:', ...alphaRun, '', 'class Beta:', ...betaRun, ''].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  // Only the new class is added; both existing `run` bodies stay byte-identical, six lines lower.
  fs.writeFileSync(
    path.join(projectDir, 'src', 'jobs.py'),
    ['class Gamma:', '    def run(self, n):', '        return n', '', 'class Alpha:', ...alphaRun, '', 'class Beta:', ...betaRun, ''].join('\n'),
    'utf8',
  );

  const baseCsv = [
    '4,13,40,2,4,"run@2-5@./src/jobs.py","./src/jobs.py","run","run( self , n )",2,5',
    '4,4,40,2,4,"run@8-11@./src/jobs.py","./src/jobs.py","run","run( self , n )",8,11',
    '',
  ].join('\n');
  const currentCsv = [
    '2,1,12,2,2,"run@2-3@src/jobs.py","src/jobs.py","run","run( self , n )",2,3',
    '4,13,40,2,4,"run@6-9@src/jobs.py","src/jobs.py","run","run( self , n )",6,9',
    '4,4,40,2,4,"run@12-15@src/jobs.py","src/jobs.py","run","run( self , n )",12,15',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures.map((entry) => `${entry.line}:${entry.reason}`), []);
  assert.equal(report.atOrAboveMax, 0);
  assert.equal(report.preExistingAtOrAboveMax, 2, 'both untouched methods stay over the ceiling, reported and not gated');
  assert.deepEqual(report.ambiguousMatches, [], 'exact source text claimed both baseline rows, and the inserted method is under the ceiling');
  assert.match(formatReport(report), /CRAP gate passed: 0 of 3 functions at or above 6; 2 pre-existing functions at or above 6/);
});

/**
 * Pairing is one-to-one, so the third `run` cannot borrow a baseline row its namesakes already claimed.
 * The file aggregate ties here, because refactoring one sibling below the ceiling cancels the new
 * offender out, which is exactly why the aggregate no longer gets to clear an unmatched function.
 */
test('a third same-named function over the ceiling is new code, even when the file aggregate ties', () => {
  const firstRun = ['function run(n) {', '  if (n > 0) return 1;', '  return 0;', '}'];
  const secondRun = ['function run(n) {', '  if (n < 0) return -1;', '  return 0;', '}'];
  const projectDir = fixtureProject({
    'src/app.js': [...firstRun, '', ...secondRun, ''].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'app.js'),
    [
      ...firstRun,
      '',
      'function run(n) {',
      '  return 0;',
      '}',
      '',
      'function run(n) {',
      '  if (n === 1) return 1;',
      '  if (n === 2) return 2;',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const baseCsv = [
    '4,10,40,1,4,"run@1-4@./src/app.js","./src/app.js","run","run ( n )",1,4',
    '4,10,40,1,4,"run@6-9@./src/app.js","./src/app.js","run","run ( n )",6,9',
    '',
  ].join('\n');
  const currentCsv = [
    '4,10,40,1,4,"run@1-4@src/app.js","src/app.js","run","run ( n )",1,4',
    '3,1,20,1,3,"run@6-8@src/app.js","src/app.js","run","run ( n )",6,8',
    '5,5,40,1,5,"run@10-14@src/app.js","src/app.js","run","run ( n )",10,14',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(
    report.failures.map((entry) => `${entry.function}@${entry.line}:${entry.reason}:crap=${entry.crap}`),
    ['run@10:ceiling:crap=30'],
  );
  assert.deepEqual(
    report.ambiguousMatches,
    [{ file: 'src/app.js', current: { overCeiling: 1, maxComplexity: 10 }, baseline: { overCeiling: 2, maxComplexity: 10 }, degraded: false }],
    'the aggregate is reported on the same metric on both sides, and it is not what decided the new run',
  );
  assert.equal(report.atOrAboveMax, 1);
  assert.doesNotMatch(formatReport(report), /CRAP gate passed/);
});

/** N baseline copies of one text match N current copies, never N + 1: a copy-paste is new code. */
test('a byte-identical copy of an over-ceiling function answers to the ceiling', () => {
  const helper = ['function helper(n) {', '  if (n > 0) return 1;', '  return 0;', '}'];
  const projectDir = fixtureProject({
    'src/util.js': [...helper, ''].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  fs.writeFileSync(path.join(projectDir, 'src', 'util.js'), [...helper, '', ...helper, ''].join('\n'), 'utf8');

  const baseCsv = '4,10,40,1,4,"helper@1-4@./src/util.js","./src/util.js","helper","helper ( n )",1,4\n';
  const currentCsv = [
    '4,10,40,1,4,"helper@1-4@src/util.js","src/util.js","helper","helper ( n )",1,4',
    '4,10,40,1,4,"helper@6-9@src/util.js","src/util.js","helper","helper ( n )",6,9',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(
    report.failures.map((entry) => `${entry.function}@${entry.line}:${entry.reason}:crap=${entry.crap}`),
    ['helper@6:ceiling:crap=110'],
  );
  assert.equal(report.preExistingAtOrAboveMax, 1, 'the original copy still pairs with its own baseline row');
});

test('one baseline copy and one current copy of identical text still pair with each other', () => {
  const helper = ['function helper(n) {', '  if (n > 0) return 1;', '  return 0;', '}'];
  const projectDir = fixtureProject({
    'src/util.js': [...helper, ''].join('\n'),
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'util.js'),
    [...helper, '', 'function tally(n) {', '  return n;', '}', ''].join('\n'),
    'utf8',
  );

  const baseCsv = '4,10,40,1,4,"helper@1-4@./src/util.js","./src/util.js","helper","helper ( n )",1,4\n';
  const currentCsv = [
    '4,10,40,1,4,"helper@1-4@src/util.js","src/util.js","helper","helper ( n )",1,4',
    '3,1,10,1,3,"tally@6-8@src/util.js","src/util.js","tally","tally ( n )",6,8',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.ambiguousMatches, []);
  assert.equal(report.preExistingAtOrAboveMax, 1);
  assert.match(formatReport(report), /CRAP gate passed: 0 of 2 functions at or above 6/);
});

/**
 * The ratchet recomputes the baseline's CRAP from the coverage this run reports, which is rounded to four
 * places, so scoring the current side from the raw ratio instead put the two numbers 0.01 apart: 26
 * branches at 2/3 coverage scored 51.04 against a baseline 51.03 and failed a function nobody had touched.
 */
test('coverage rounding alone never fails a function whose complexity held', () => {
  const render = ['function render(rows) {', '  if (!rows) return 0;', '  if (rows.length) return 1;', '  return 2;', '}'];
  const projectDir = fixtureProject({
    'src/report.js': [...render, ''].join('\n'),
    'coverage/lcov.info': 'SF:src/report.js\nDA:2,1\nDA:3,1\nDA:4,0\nend_of_record\n',
  });
  initFixtureRepository(projectDir);

  fs.writeFileSync(
    path.join(projectDir, 'src', 'report.js'),
    [...render, '', 'function tally(rows) {', '  return rows.length;', '}', ''].join('\n'),
    'utf8',
  );

  const baseCsv = '5,26,40,1,5,"render@1-5@./src/report.js","./src/report.js","render","render ( rows )",1,5\n';
  const currentCsv = [
    '5,26,40,1,5,"render@1-5@src/report.js","src/report.js","render","render ( rows )",1,5',
    '3,1,10,1,3,"tally@7-9@src/report.js","src/report.js","tally","tally ( rows )",7,9',
    '',
  ].join('\n');
  const runLizard = ({ cwd }) => (isBaselineCwd(cwd) ? baseCsv : currentCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  const rendered = functionNamed(report, 'render');
  assert.deepEqual({ cc: rendered.cc, coverage: rendered.coverage, crap: rendered.crap }, { cc: 26, coverage: 0.6667, crap: 51.03 });
  assert.equal(rounded2(crapScore(26, 2 / 3)), 51.04, 'the raw ratio scores 0.01 higher, which is what used to fail the gate');
  assert.equal(rounded2(crapScore(26, rendered.coverage)), rendered.crap, 'reported CRAP comes from the reported coverage');
  assert.deepEqual(report.failures, [], 'the same complexity at the same coverage is not a regression');
  assert.equal(report.preExistingAtOrAboveMax, 1);
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

/**
 * With --project omitted, projectDir is raw cwd; the measured root walks up to the git toplevel, and
 * the config lookup has to follow it there too, or a subdirectory run reads no config at all and falls
 * back to every default (no ratchet, no coverage command, max 6).
 */
test('config resolves from the measured root when --project is not given, from the root and from a subdirectory', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ max: 500 }),
    'src/hairy.js': [
      'function hairy(n) {',
      '  if (n > 1) return 1;',
      '  if (n > 2) return 2;',
      '  if (n > 3) return 3;',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    'complexity.csv': '6,4,20,1,6,"hairy@1-6@src/hairy.js","src/hairy.js","hairy","hairy ( n )",1,6\n',
    'coverage/lcov.info': '',
  });
  initFixtureRepository(projectDir);

  const fromRoot = crapReport({ projectDir, cwd: projectDir, complexity: 'complexity.csv' });
  assert.equal(fromRoot.max, 500, 'the root run reads the config directly');
  assert.equal(fromRoot.failures.length, 0);

  const subDir = path.join(projectDir, 'src');
  const fromSubdir = crapReport({ projectDir: subDir, cwd: subDir, complexity: path.join(projectDir, 'complexity.csv') });
  assert.equal(fromSubdir.max, 500, 'the subdirectory run still reads the config from the measured git toplevel, not from cwd');
  assert.equal(fromSubdir.failures.length, 0);
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

/**
 * A coverage command that exits 0 but writes nothing leaves the default lcov exactly as stale as
 * before this run; without a freshness check the gate would silently score against yesterday's
 * coverage instead of refusing with "could not measure".
 */
test('a coverage command that writes nothing leaves a stale lcov, and the gate refuses instead of trusting it', () => {
  const projectDir = fixtureProject({
    'complexity.csv': '4,4,20,1,4,"branchy@1-4@src/branchy.js","src/branchy.js","branchy","branchy ( n )",1,4\n',
    'coverage/lcov.info': 'SF:src/branchy.js\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n',
  });
  const staleSeconds = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(projectDir, 'coverage', 'lcov.info'), staleSeconds, staleSeconds);

  const result = runCli(['--complexity', 'complexity.csv', '--coverage-command', 'node -e "process.exit(0)"'], projectDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /predates/);
});

function gitAt(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function initRepo(dir) {
  const git = gitAt(dir);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CRAP test']);
  git(['config', 'user.email', 'crap-test@example.invalid']);
  return git;
}

test('running the gate from a linked worktree with --project <main checkout> measures the worktree', () => {
  const mainDir = fixtureProject({ 'README.md': 'main\n' });
  const git = initRepo(mainDir);
  git(['add', '.']);
  git(['commit', '-m', 'base']);

  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-worktree-'));
  const worktreeDir = path.join(worktreeParent, 'wt');
  git(['worktree', 'add', '-b', 'wt-branch', worktreeDir, 'main']);

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-stub-'));
  const markerPath = path.join(stubDir, 'marker.json');
  const scriptPath = path.join(stubDir, 'coverage-stub.js');
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.mkdirSync('coverage', { recursive: true });",
      "fs.writeFileSync(path.join('coverage', 'lcov.info'), 'SF:a.js\\nDA:1,1\\nend_of_record\\n', 'utf8');",
      `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ cwd: process.cwd() }));`,
    ].join('\n'),
    'utf8',
  );

  const lizardCalls = [];
  const runLizard = ({ cwd, sources, exclude }) => {
    lizardCalls.push({ cwd, sources, exclude });
    return '';
  };

  const report = crapReport({
    projectDir: mainDir,
    cwd: worktreeDir,
    projectPathGiven: true,
    coverageCommand: `node "${scriptPath}"`,
    runLizard,
  });

  assert.ok(sameRealDir(report.root, worktreeDir), `expected ${report.root} to be the worktree ${worktreeDir}`);
  assert.equal(lizardCalls.length, 1);
  assert.ok(sameRealDir(lizardCalls[0].cwd, worktreeDir), `expected lizard cwd ${lizardCalls[0].cwd} to be the worktree ${worktreeDir}`);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.ok(sameRealDir(marker.cwd, worktreeDir), 'coverage command ran with cwd inside the worktree');
  assert.equal(fs.existsSync(path.join(mainDir, 'coverage')), false, 'the main checkout never got a coverage directory written to it');
});

test('two runs sharing a workDir isolate their coverage reports from each other', () => {
  const workDir = fixtureProject({
    'complexity.csv': '4,2,19,2,4,"add@1-4@src/sample.js","src/sample.js","add","add ( a , b )",1,4\n',
  });
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-stub-'));
  const logPath = path.join(stubDir, 'dirs.log');
  const scriptPath = path.join(stubDir, 'coverage-stub.js');
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      `const dir = process.env[${JSON.stringify(COVERAGE_DIR_ENV)}];`,
      "fs.appendFileSync(process.env.CRAP_TEST_LOG, dir + '\\n');",
      "fs.mkdirSync(dir, { recursive: true });",
      "fs.writeFileSync(path.join(dir, 'lcov.info'), process.env.CRAP_TEST_LCOV, 'utf8');",
    ].join('\n'),
    'utf8',
  );

  const runWith = (lcovBody) => {
    process.env.CRAP_TEST_LOG = logPath;
    process.env.CRAP_TEST_LCOV = lcovBody;
    try {
      return crapReport({ projectDir: workDir, complexity: 'complexity.csv', coverageCommand: `node "${scriptPath}"` });
    } finally {
      delete process.env.CRAP_TEST_LOG;
      delete process.env.CRAP_TEST_LCOV;
    }
  };

  const first = runWith('SF:src/sample.js\nDA:2,1\nDA:3,0\nend_of_record\n');
  const second = runWith('SF:src/sample.js\nDA:2,0\nDA:3,0\nend_of_record\n');

  const dirs = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(dirs.length, 2, 'both runs recorded a coverage directory');
  assert.notEqual(dirs[0], dirs[1], 'concurrent runs must not share a coverage report directory');

  const firstAdd = first.functions.find((entry) => entry.function === 'add');
  const secondAdd = second.functions.find((entry) => entry.function === 'add');
  assert.equal(firstAdd.coverage, 0.5, "first run reads its own run's lcov, unaffected by the second");
  assert.equal(secondAdd.coverage, 0, "second run reads its own run's lcov, unaffected by the first");
});

/** Plain recursive walk, not fs.readdirSync's `recursive` option, so this runs the same on every supported Node. */
function collectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(fullPath));
    else results.push(fullPath);
  }
  return results;
}

test('the generated crap-gate live rule has no hard-coded main-checkout path, and no file under skills/ tells an agent to pass --project to the crap gate', () => {
  const crapGateDoc = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'setup', 'references', 'crap-gate.md'),
    'utf8',
  );
  const liveRuleMatch = crapGateDoc.match(/```markdown\n([\s\S]*?)```/);
  assert.ok(liveRuleMatch, 'the reference doc has a fenced live-rule template');
  const liveRuleBlock = liveRuleMatch[1];
  assert.match(liveRuleBlock, /quartermaster\.js" crap`/);
  assert.doesNotMatch(liveRuleBlock, /--project/);
  assert.doesNotMatch(liveRuleBlock, /"\/[^"]+"/, 'no absolute path baked into the rule text');

  const skillsDir = path.join(__dirname, '..', 'skills');
  const offenders = collectFiles(skillsDir)
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('crap --project'))
    .map((filePath) => path.relative(skillsDir, filePath));
  assert.deepEqual(offenders, [], 'no file under skills/ should tell an agent to pass --project to the crap gate');
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
