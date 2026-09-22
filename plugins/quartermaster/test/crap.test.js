'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { COVERAGE_DIR_ENV, crapReport, crapScore, formatReport, PrerequisiteError, realDir, sameDir } = require('../lib/crap.js');

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

function csv(entries, file = 'src/app.js') {
  return `${entries.map(({ complexity, name, start, end }) => `${end - start + 1},${complexity},10,1,${end - start + 1},"${name}@${start}-${end}@${file}","${file}","${name}","${name} ()",${start},${end}`).join('\n')}\n`;
}

function lcov(lines, file = 'src/app.js') {
  return `SF:${file}\n${lines.map(([line, hits]) => `DA:${line},${hits}`).join('\n')}\nend_of_record\n`;
}

function runner(current, base) {
  return ({ cwd }) => (path.basename(cwd).startsWith('quartermaster-crap-base-') ? base : current);
}

/** The gate resolves lizard itself; skip only when none of the three ways to reach it works here. */
function lizardResolves() {
  for (const [command, leading] of [['lizard', []], ['uvx', ['lizard']], ['pipx', ['run', 'lizard']]]) {
    const probe = spawnSync(command, [...leading, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return true;
  }
  return false;
}

function phantomFixture() {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'jsx-phantom-complexity.tsx'), 'utf8');
}

function atLine(report, line) {
  return report.functions.find((entry) => entry.line === line);
}

function gitIn(cwd, argumentsForGit) {
  return execFileSync('git', argumentsForGit, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/**
 * The gate realpath-normalizes a git root, which expands Windows 8.3 short names and symlinks, so a raw
 * comparison against the fixture's own temp path would disagree on Windows for the same directory.
 */
function sameRealDir(left, right) {
  return sameDir(realDir(left), realDir(right));
}

/** A coverage command stand-in: a script file, so no test has to quote JavaScript through a shell. */
function coverageStub(lines) {
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-stub-')), 'coverage-stub.js');
  fs.writeFileSync(scriptPath, ["const fs = require('fs');", "const path = require('path');", ...lines].join('\n'), 'utf8');
  return { command: `"${process.execPath}" "${scriptPath}"`, dir: path.dirname(scriptPath) };
}

function makeStale(filePath) {
  const dayAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(filePath, dayAgo, dayAgo);
}

test('sameRealDir resolves a symlinked alias the way native realpath does, unlike plain realpathSync', () => {
  // A symlink alias stands in for a Windows 8.3 short name, and the non-native realpathSync is stubbed to
  // leave its input unresolved the way it leaves short names unexpanded on Windows.
  const realDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-real-'));
  const aliasDirPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-alias-')), 'alias');
  fs.symlinkSync(realDirPath, aliasDirPath, 'dir');

  const originalRealpathSync = fs.realpathSync;
  const stubbedRealpathSync = (target) => target;
  stubbedRealpathSync.native = originalRealpathSync.native;
  fs.realpathSync = stubbedRealpathSync;
  try {
    assert.equal(fs.realpathSync(aliasDirPath), aliasDirPath, 'the stub leaves the alias unresolved, like an unexpanded 8.3 short name');
    assert.ok(sameRealDir(aliasDirPath, realDirPath), 'realDir must resolve through realpathSync.native, which still dereferences the symlink');
  } finally {
    fs.realpathSync = originalRealpathSync;
  }
});

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

/**
 * The defect this fixture pins: identity by position among namesakes moves when a namesake is inserted
 * ahead of it, so Alpha's untouched `run` was read against Beta's baseline row, called changed, and failed
 * on a ceiling it had always been over. One-to-one pairing by source text keeps it out of the gate.
 */
test('an untouched namesake keeps its own baseline row when an insertion shifts its position', () => {
  const alphaRun = ['    def run(self, n):', '        if n > 0:', '            return 1', '        return 0'];
  const betaRun = ['    def run(self, n):', '        if n < 0:', '            return -1', '        return 0'];
  const projectDir = fixtureProject({
    'src/jobs.py': ['class Alpha:', ...alphaRun, '', 'class Beta:', ...betaRun, ''].join('\n'),
    'coverage/lcov.info': lcov([[3, 1], [7, 1], [8, 1], [9, 1], [13, 1], [14, 1], [15, 1]], 'src/jobs.py'),
  });
  commitBase(projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'src/jobs.py'),
    ['class Gamma:', '    def run(self, n):', '        return n', '', 'class Alpha:', ...alphaRun, '', 'class Beta:', ...betaRun, ''].join('\n'),
    'utf8',
  );

  const report = crapReport({
    projectDir,
    base: 'main',
    runLizard: runner(
      csv([{ complexity: 1, name: 'run', start: 2, end: 3 }, { complexity: 13, name: 'run', start: 6, end: 9 }, { complexity: 4, name: 'run', start: 12, end: 15 }], 'src/jobs.py'),
      csv([{ complexity: 13, name: 'run', start: 2, end: 5 }, { complexity: 4, name: 'run', start: 8, end: 11 }], 'src/jobs.py'),
    ),
  });

  assert.deepEqual(report.failures, []);
  assert.equal(report.checked, 1, 'only the inserted method is judged');
  assert.equal(atLine(report, 6).crap, 13, 'the untouched method sits over the ceiling on complexity alone and is still not gated');
  assert.equal(formatReport(report), 'CRAP gate passed: 0 of 1 changed or new functions at or above 6\n');
});

/** N baseline copies of one text pair with N current copies, never N + 1: a copy-paste is new code. */
test('a byte-identical copy of an over-ceiling function is new code and fails', () => {
  const helper = ['function helper(n) {', '  if (n > 0) return 1;', '  return 0;', '}'];
  const projectDir = fixtureProject({
    'src/util.js': [...helper, ''].join('\n'),
    'coverage/lcov.info': lcov([[2, 1], [3, 1], [7, 1], [8, 1]], 'src/util.js'),
  });
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/util.js'), [...helper, '', ...helper, ''].join('\n'), 'utf8');

  const report = crapReport({
    projectDir,
    base: 'main',
    runLizard: runner(
      csv([{ complexity: 10, name: 'helper', start: 1, end: 4 }, { complexity: 10, name: 'helper', start: 6, end: 9 }], 'src/util.js'),
      csv([{ complexity: 10, name: 'helper', start: 1, end: 4 }], 'src/util.js'),
    ),
  });

  assert.deepEqual(report.failures.map((entry) => entry.line), [6], 'the original copy keeps the only baseline row there was');
  assert.equal(report.checked, 1);
  assert.equal(formatReport(report), 'src/util.js:6 helper cc=10 coverage=100% CRAP=10\nCRAP gate failed: 1 of 1 changed or new functions at or above 6\n');
});

test('a third same-named function over the ceiling is new code the baseline cannot account for', () => {
  const firstRun = ['function run(n) {', '  if (n > 0) return 1;', '  return 0;', '}'];
  const secondRun = ['function run(n) {', '  if (n < 0) return -1;', '  return 0;', '}'];
  const thirdRun = [
    'function run(n) {',
    '  if (n === 1) return 1;',
    '  if (n === 2) return 2;',
    '  if (n === 3) return 3;',
    '  if (n === 4) return 4;',
    '  if (n === 5) return 5;',
    '  if (n === 6) return 6;',
    '  return 0;',
    '}',
  ];
  const projectDir = fixtureProject({
    'src/app.js': [...firstRun, '', ...secondRun, ''].join('\n'),
    'coverage/lcov.info': lcov([[2, 1], [3, 1], [7, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 1], [17, 1]]),
  });
  commitBase(projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'src/app.js'),
    [...firstRun, '', 'function run(n) {', '  return 0;', '}', '', ...thirdRun, ''].join('\n'),
    'utf8',
  );

  const report = crapReport({
    projectDir,
    base: 'main',
    runLizard: runner(
      csv([{ complexity: 10, name: 'run', start: 1, end: 4 }, { complexity: 1, name: 'run', start: 6, end: 8 }, { complexity: 7, name: 'run', start: 10, end: 18 }]),
      csv([{ complexity: 10, name: 'run', start: 1, end: 4 }, { complexity: 10, name: 'run', start: 6, end: 9 }]),
    ),
  });

  assert.deepEqual(report.failures.map((entry) => `${entry.line}:${entry.crap}`), ['10:7']);
  assert.equal(report.checked, 2, 'the rewritten second and the added third are judged; the untouched first is not');
  assert.equal(atLine(report, 1).crap, 10, 'the untouched first copy is over the ceiling and out of the gate');
  assert.equal(formatReport(report), 'src/app.js:10 run cc=7 coverage=100% CRAP=7\nCRAP gate failed: 1 of 2 changed or new functions at or above 6\n');
});

test('a byte-identical arrow keeps its baseline row after neighbours push it down the file', () => {
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
    'coverage/lcov.info': lcov([[2, 1], [6, 1], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1]], 'src/widget.js'),
  });
  commitBase(projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'src/widget.js'),
    ['const helperA = (x) => {', '  return x + 1;', '};', '', 'const helperB = (x) => {', '  return x - 1;', '};', '', ...widget, ''].join('\n'),
    'utf8',
  );

  const report = crapReport({
    projectDir,
    base: 'main',
    runLizard: runner(
      csv([{ complexity: 1, name: '(anonymous)', start: 1, end: 3 }, { complexity: 1, name: '(anonymous)', start: 5, end: 7 }, { complexity: 20, name: '(anonymous)', start: 9, end: 15 }], 'src/widget.js'),
      csv([{ complexity: 20, name: '(anonymous)', start: 1, end: 7 }], 'src/widget.js'),
    ),
  });

  assert.deepEqual(report.failures, []);
  assert.equal(report.checked, 2, 'only the two added helpers are judged');
  assert.equal(atLine(report, 9).crap, 20, 'the moved component is over the ceiling and paired with its own baseline row');
});

test('CRAP comes from the lcov lines inside each function, whatever slashes the lcov used', () => {
  const projectDir = fixtureProject({
    // lizard reports src/sample.js with forward slashes and src\sample.py with backslashes; the lcov
    // below uses the opposite style for each, plus an absolute path, which all have to match anyway.
    'complexity.csv': [
      '4,2,19,2,4,"add@1-4@src/sample.js","src/sample.js","add","add ( a , b )",1,4',
      '9,4,60,1,9,"tangle@6-14@src/sample.js","src/sample.js","tangle","tangle ( n )",6,14',
      '4,2,16,2,4,"add@1-4@src\\sample.py","src\\sample.py","add","add( a , b )",1,4',
      '',
    ].join('\n'),
    'coverage/lcov.info': [
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
      '',
    ].join('\n'),
  });
  fs.appendFileSync(
    path.join(projectDir, 'coverage/lcov.info'),
    [`SF:${path.join(projectDir, 'src', 'sample.py').replaceAll('\\', '/')}`, 'DA:2,1', 'DA:3,1', 'DA:4,0', 'end_of_record', ''].join('\n'),
    'utf8',
  );

  const report = crapReport({ projectDir, complexity: 'complexity.csv' });

  const javascriptAdd = report.functions.find((entry) => entry.file === 'src/sample.js' && entry.function === 'add');
  assert.deepEqual({ coverage: javascriptAdd.coverage, crap: javascriptAdd.crap }, { coverage: 0.5, crap: 2.5 });
  const tangle = report.functions.find((entry) => entry.function === 'tangle');
  assert.deepEqual({ coverage: tangle.coverage, crap: tangle.crap }, { coverage: 0.6667, crap: 4.59 });
  const pythonAdd = report.functions.find((entry) => entry.file === 'src/sample.py');
  assert.deepEqual({ coverage: pythonAdd.coverage, crap: pythonAdd.crap }, { coverage: 0.6667, crap: 2.15 });
  assert.equal(crapScore(2, 2 / 3), pythonAdd.cc ** 2 * (1 - 2 / 3) ** 3 + pythonAdd.cc);
  assert.equal(report.max, 6);
  assert.equal(formatReport(report), 'CRAP gate passed: 0 of 3 changed or new functions at or above 6\n');
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

test('without --project the config comes from the measured root, so its base and exclude hold from a subdirectory', () => {
  const projectDir = fixtureProject({
    '.claude/quartermaster/crap.json': JSON.stringify({ base: 'crap-base', exclude: ['vendor/**'] }),
    'src/app.js': 'function subject(value) { return value; }\n',
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  commitBase(projectDir);
  gitIn(projectDir, ['tag', 'crap-base']);
  const configuredBase = gitIn(projectDir, ['rev-parse', 'HEAD']);
  // Moving the default branch past the tag makes the configured base and the default one differ.
  fs.writeFileSync(path.join(projectDir, 'README.md'), 'after the base\n', 'utf8');
  gitIn(projectDir, ['add', 'README.md']);
  gitIn(projectDir, ['commit', '-m', 'after the base']);

  const subDir = path.join(projectDir, 'src');
  const lizardCalls = [];
  const runLizard = (call) => {
    lizardCalls.push(call);
    return csv([{ complexity: 1, name: 'subject', start: 1, end: 1 }]);
  };
  for (const [label, options] of [
    ['from the root', { projectDir, cwd: projectDir }],
    ['from a subdirectory', { projectDir: subDir, cwd: subDir }],
    ['from a subdirectory with --project', { projectDir, cwd: subDir, projectPathGiven: true }],
  ]) {
    const report = crapReport({ ...options, runLizard });
    assert.equal(report.base, configuredBase, `${label}: the config's base, not the default branch`);
    assert.deepEqual(lizardCalls.at(-1).exclude, ['vendor/**'], `${label}: the config's exclude`);
    assert.ok(sameRealDir(report.root, projectDir), `${label}: measured the repository root, got ${report.root}`);
  }
});

test('from a linked worktree with --project naming the main checkout, the gate measures the worktree with the main config', () => {
  const mainDir = fixtureProject({ 'README.md': 'main\n' });
  commitBase(mainDir);
  const worktreeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-worktree-')), 'wt');
  gitIn(mainDir, ['worktree', 'add', '-b', 'wt-branch', worktreeDir, 'main']);
  // Untracked, so only the main checkout has it: seeing it applied proves --project picked the config.
  fs.mkdirSync(path.join(mainDir, '.claude', 'quartermaster'), { recursive: true });
  fs.writeFileSync(path.join(mainDir, '.claude', 'quartermaster', 'crap.json'), JSON.stringify({ exclude: ['vendor/**'] }), 'utf8');
  const stub = coverageStub([
    "fs.mkdirSync('coverage', { recursive: true });",
    "fs.writeFileSync(path.join('coverage', 'lcov.info'), 'SF:a.js\\nDA:1,1\\nend_of_record\\n', 'utf8');",
    "fs.writeFileSync(path.join(__dirname, 'marker.json'), JSON.stringify({ cwd: process.cwd() }));",
  ]);
  const lizardCalls = [];

  const report = crapReport({
    projectDir: mainDir,
    cwd: worktreeDir,
    projectPathGiven: true,
    coverageCommand: stub.command,
    runLizard: (call) => {
      lizardCalls.push(call);
      return '';
    },
  });

  assert.ok(sameRealDir(report.root, worktreeDir), `expected ${report.root} to be the worktree ${worktreeDir}`);
  assert.equal(lizardCalls.length, 1);
  assert.ok(sameRealDir(lizardCalls[0].cwd, worktreeDir), `expected lizard cwd ${lizardCalls[0].cwd} to be the worktree`);
  assert.deepEqual(lizardCalls[0].exclude, ['vendor/**'], 'the config came from the --project checkout');
  const marker = JSON.parse(fs.readFileSync(path.join(stub.dir, 'marker.json'), 'utf8'));
  assert.ok(sameRealDir(marker.cwd, worktreeDir), 'the coverage command ran in the worktree');
  assert.equal(fs.existsSync(path.join(mainDir, 'coverage')), false, 'the main checkout never got coverage written to it');
});

test('two runs on one checkout each read the lcov their own coverage command wrote', () => {
  const workDir = fixtureProject({
    'complexity.csv': csv([{ complexity: 2, name: 'add', start: 1, end: 4 }], 'src/sample.js'),
    // An old shared lcov must neither shadow a run's own report nor trip the staleness refusal.
    'coverage/lcov.info': lcov([[2, 1], [3, 1]], 'src/sample.js'),
  });
  makeStale(path.join(workDir, 'coverage', 'lcov.info'));
  const stub = coverageStub([
    `const dir = process.env[${JSON.stringify(COVERAGE_DIR_ENV)}];`,
    "fs.appendFileSync(path.join(__dirname, 'dirs.log'), dir + '\\n');",
    "fs.writeFileSync(path.join(dir, 'lcov.info'), process.env.CRAP_TEST_LCOV, 'utf8');",
  ]);
  const runWith = (lcovBody) => {
    process.env.CRAP_TEST_LCOV = lcovBody;
    try {
      return crapReport({ projectDir: workDir, complexity: 'complexity.csv', coverageCommand: stub.command });
    } finally {
      delete process.env.CRAP_TEST_LCOV;
    }
  };

  const first = runWith(lcov([[2, 1], [3, 0]], 'src/sample.js'));
  const second = runWith(lcov([[2, 0], [3, 0]], 'src/sample.js'));

  const dirs = fs.readFileSync(path.join(stub.dir, 'dirs.log'), 'utf8').trim().split('\n');
  assert.equal(dirs.length, 2, 'both runs recorded a coverage directory');
  assert.notEqual(dirs[0], dirs[1], 'two runs must not share a coverage report directory');
  assert.equal(first.functions[0].coverage, 0.5, "the first run reads its own run's lcov");
  assert.equal(second.functions[0].coverage, 0, "the second run reads its own run's lcov");
});

test('a coverage command that exits 0 without rewriting the default lcov exits two, and one that rewrites it passes', () => {
  const projectDir = fixtureProject({
    'complexity.csv': csv([{ complexity: 1, name: 'subject', start: 1, end: 1 }]),
    'coverage/lcov.info': lcov([[1, 1]]),
  });
  makeStale(path.join(projectDir, 'coverage', 'lcov.info'));

  const silent = coverageStub(['process.exit(0);']);
  const stale = runCli(['--complexity', 'complexity.csv', '--coverage-command', silent.command], projectDir);
  assert.equal(stale.status, 2, stale.stderr);
  assert.match(stale.stderr, /coverage\/lcov\.info predates this run's coverage command/);

  const rewriting = coverageStub(["fs.writeFileSync(path.join('coverage', 'lcov.info'), 'SF:src/app.js\\nDA:1,1\\nend_of_record\\n', 'utf8');"]);
  const fresh = runCli(['--complexity', 'complexity.csv', '--coverage-command', rewriting.command], projectDir);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /CRAP gate passed: 0 of 1 changed or new functions/);
});

/** A plain recursive walk rather than readdirSync's `recursive` option, so it runs the same on every supported Node. */
function collectFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
  });
}

test('the generated live rule and every file under skills/ run the gate without a hard-coded --project', () => {
  const crapGateDoc = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'references', 'crap-gate.md'), 'utf8');
  const liveRuleMatch = crapGateDoc.match(/```markdown\n([\s\S]*?)```/);
  assert.ok(liveRuleMatch, 'the reference doc has a fenced live-rule template');
  assert.match(liveRuleMatch[1], /quartermaster\.js" crap`/);
  assert.doesNotMatch(liveRuleMatch[1], /--project/);

  const skillsDir = path.join(__dirname, '..', 'skills');
  const offenders = collectFiles(skillsDir)
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('crap --project'))
    .map((filePath) => path.relative(skillsDir, filePath));
  assert.deepEqual(offenders, [], 'no file under skills/ may tell an agent to pass --project to the crap gate');
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
  assert.ok(sameRealDir(report.root, projectDir), 'a --project outside the runner\'s repository is measured where it points');
  assert.match(result.stderr, /quartermaster crap: measured /);
  assert.equal(report.checked, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(crapScore(2, 1), 2);
});

test('a .tsx tag lizard gives up on cannot invent complexity, or hide the function it swallowed', (t) => {
  if (!lizardResolves()) {
    t.skip('lizard does not resolve here');
    return;
  }
  // lizard's own TSX reader reads this fixture as one SaleField spanning lines 16-33 at cc=3 and never
  // reports SaleTotals at all, so SaleTotals' uncovered line would pass unseen. The hand counts in the
  // fixture are SaleField 1, packsLabel 2, SaleTotals 3.
  const projectDir = fs.realpathSync.native(
    fixtureProject({ 'src/sale.tsx': phantomFixture(), 'coverage/lcov.info': lcov([[17, 1], [25, 1], [28, 0]], 'src/sale.tsx') }),
  );

  const result = runCli(['--json'], projectDir);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.functions.map((entry) => `${entry.function}@${entry.line} cc=${entry.cc} ${entry.source}`).sort(),
    [
      'SaleField@16 cc=1 lizard-typescript',
      'SaleTotals@27 cc=3 lizard-typescript',
      'packsLabel@25 cc=2 lizard-typescript',
    ],
  );

  const gated = runCli([], projectDir);
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stdout, /^src\/sale\.tsx:27 SaleTotals cc=3 coverage=0% CRAP=12 source=lizard-typescript$/m);
});

test('the TypeScript reader measures the real .tsx bytes under a name that only picks the reader, and a .ts file keeps the default reader', () => {
  const source = phantomFixture();
  const projectDir = fs.realpathSync.native(
    fixtureProject({
      'src/sale.tsx': source,
      'src/total.ts': 'export const total = (values: number[]) => values.length;\n',
      'coverage/lcov.info': `${lcov([[17, 1]], 'src/sale.tsx')}${lcov([[1, 1]], 'src/total.ts')}`,
    }),
  );
  const copies = [];
  const runLizard = ({ cwd }) => {
    if (path.resolve(cwd) === path.resolve(projectDir)) {
      return `${csv([{ complexity: 3, name: 'SaleField', start: 16, end: 33 }], './src/sale.tsx')}${csv([{ complexity: 1, name: 'total', start: 1, end: 1 }], './src/total.ts')}`;
    }
    // The scratch tree is gone by the time crapReport returns, so read it while lizard would have.
    for (const name of fs.readdirSync(cwd)) copies.push({ name, text: fs.readFileSync(path.join(cwd, name), 'utf8') });
    return csv([{ complexity: 1, name: 'SaleField', start: 16, end: 20 }], `./${copies[0].name}`);
  };

  const report = crapReport({ projectDir, runLizard });

  assert.deepEqual(copies.map((copy) => path.extname(copy.name)), ['.ts'], 'only the .tsx is copied, under a name that picks the TypeScript reader');
  assert.equal(copies[0].text, source, 'the copy is the real file byte for byte');
  assert.deepEqual(
    report.functions.map((entry) => `${entry.file}:${entry.line} cc=${entry.cc} ${entry.source}`).sort(),
    ['src/sale.tsx:16 cc=1 lizard-typescript', 'src/total.ts:1 cc=1 lizard'],
    'the substitute row comes back under the real .tsx path, and the .ts row is the default reader\'s own',
  );
});

test('an untouched component in a changed .tsx keeps its baseline row, because the base revision is read by the same reader', () => {
  const source = phantomFixture();
  const projectDir = fs.realpathSync.native(
    fixtureProject({ 'src/sale.tsx': source, 'coverage/lcov.info': lcov([[17, 1], [25, 1], [28, 0]], 'src/sale.tsx') }),
  );
  commitBase(projectDir);
  fs.writeFileSync(path.join(projectDir, 'src/sale.tsx'), source.replace('"packs" : "none"', '"packs" : "no packs"'), 'utf8');
  // lizard's two readers as they read this fixture: the TSX reader folds everything below the
  // `data-testid` tag into SaleField and never reports SaleTotals; the TypeScript reader reports all three.
  const rowsByReader = {
    '.tsx': [{ complexity: 3, name: 'SaleField', start: 16, end: 33 }, { complexity: 2, name: 'packsLabel', start: 25, end: 25 }],
    '.ts': [
      { complexity: 1, name: 'SaleField', start: 16, end: 20 },
      { complexity: 2, name: 'packsLabel', start: 25, end: 25 },
      { complexity: 3, name: 'SaleTotals', start: 27, end: 31 },
    ],
  };
  const reads = [];
  const runLizard = ({ cwd }) => {
    const file = fs.existsSync(path.join(cwd, 'src', 'sale.tsx')) ? 'src/sale.tsx' : fs.readdirSync(cwd)[0];
    reads.push(path.extname(file));
    return csv(rowsByReader[path.extname(file)], file);
  };

  const report = crapReport({ projectDir, ratchet: 'main', runLizard });

  assert.deepEqual(report.failures, [], 'SaleTotals is untouched, so its uncovered line is not this change\'s to gate');
  assert.equal(report.checked, 1, 'only packsLabel changed');
  assert.deepEqual(reads, ['.tsx', '.ts', '.tsx', '.ts'], 'the working tree and the base revision each get a TypeScript-reader pass');
});
