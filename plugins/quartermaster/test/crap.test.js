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

test('an anonymous function is not a false new offender when its complexity falls and neighbors shift its position', () => {
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

  // lizard reports every one of these as "(anonymous)"; extracting two helpers ahead of the component
  // shifts its position among same-named siblings even though its own complexity dropped 20 -> 15.
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
  const runLizard = ({ cwd }) => (classifyRatchetCwd(cwd, projectDir) === 'current' ? currentCsv : baseCsv);

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures, []);
  assert.equal(report.ambiguousMatches.length, 1);
  assert.deepEqual(
    { file: report.ambiguousMatches[0].file, degraded: report.ambiguousMatches[0].degraded },
    { file: 'src/widget.js', degraded: false },
  );
  assert.match(formatReport(report), /src\/widget\.js: ambiguous match/);
  assert.match(formatReport(report), /CRAP gate passed/);
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
    { line: 9, reason: 'ambiguous' },
  );
  assert.equal(report.ambiguousMatches[0].degraded, true);
  assert.match(formatReport(report), /CRAP gate failed: 1 of 3 functions/);
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
  assert.equal(lizardCalls[0].cwd, worktreeDir);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(fs.realpathSync(marker.cwd), fs.realpathSync(worktreeDir), 'coverage command ran with cwd inside the worktree');
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

test('the generated crap-gate live rule has no hard-coded main-checkout path', () => {
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
