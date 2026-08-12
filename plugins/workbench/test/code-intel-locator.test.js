'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { locateLanguageServer, languageForFile, NATIVE_SERVER_ENV, LANGUAGE_SERVER_ENV } = require('../lib/code-intel/language-server-locator.js');
const { resolveInterpreter, PYTHON_INTERPRETER_ENV } = require('../lib/code-intel/language-server-locators/python.js');

const cleanEnv = { PATH: '' };

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function plantNativeExecutable(baseDir) {
  const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
  const libDir = path.join(baseDir, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const executablePath = path.join(libDir, executableName);
  fs.writeFileSync(executablePath, '');
  return executablePath;
}

function plantWrapperCli(baseDir) {
  const libDir = path.join(baseDir, 'node_modules', 'typescript-language-server', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const cliPath = path.join(libDir, 'cli.mjs');
  fs.writeFileSync(cliPath, '');
  return cliPath;
}

test('Python source and interface files select the Python language server', () => {
  assert.equal(languageForFile('module.py'), 'python');
  assert.equal(languageForFile('package.pyi'), 'python');
});

test('Python package without a virtual environment refuses despite a Python executable on PATH', () => {
  const root = makeTempDir('code-intel-python-no-venv-');
  const packageDir = path.join(root, 'card-classifiers');
  const filePath = path.join(packageDir, 'module.py');
  const pythonBinDir = makeTempDir('code-intel-python-path-');
  const pythonExecutable = path.join(pythonBinDir, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(filePath, 'import installed_dependency\n');
  fs.writeFileSync(path.join(packageDir, 'pyproject.toml'), '[project]\nname = "card-classifiers"\n');
  fs.writeFileSync(pythonExecutable, '');

  const outcome = resolveInterpreter(root, filePath, { PATH: pythonBinDir });

  assert.match(outcome.error, /card-classifiers/);
  assert.match(outcome.error, /declares dependencies with no environment/);
  assert.match(outcome.error, /WORKBENCH_CODE_INTEL_PYTHON_INTERPRETER/);
});

test('Python source outside packaging metadata resolves a Python executable on PATH', () => {
  const root = makeTempDir('code-intel-python-path-');
  const filePath = path.join(root, 'maintenance.py');
  const pythonBinDir = makeTempDir('code-intel-python-path-');
  const pythonExecutable = path.join(pythonBinDir, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(filePath, 'print("maintenance")\n');
  fs.writeFileSync(pythonExecutable, '');

  assert.equal(resolveInterpreter(root, filePath, { PATH: pythonBinDir }).interpreter, pythonExecutable);
});

test('Python interpreter resolution uses the nearest package virtual environment from the file', () => {
  const root = makeTempDir('code-intel-python-monorepo-');
  const pokerAiFile = path.join(root, 'poker-ai', 'source', 'module.py');
  const pokerGymFile = path.join(root, 'poker-gym', 'source', 'module.py');
  for (const filePath of [pokerAiFile, pokerGymFile]) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const executableName = process.platform === 'win32' ? 'python.exe' : 'python';
  const pokerAiInterpreter = path.join(root, 'poker-ai', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', executableName);
  const pokerGymInterpreter = path.join(root, 'poker-gym', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', executableName);
  for (const interpreter of [pokerAiInterpreter, pokerGymInterpreter]) {
    fs.mkdirSync(path.dirname(interpreter), { recursive: true });
    fs.writeFileSync(interpreter, '');
  }
  assert.equal(resolveInterpreter(root, pokerAiFile, cleanEnv).interpreter, pokerAiInterpreter);
  assert.equal(resolveInterpreter(root, pokerGymFile, cleanEnv).interpreter, pokerGymInterpreter);
});

test('Python interpreter override wins over package virtual environments', () => {
  const root = makeTempDir('code-intel-python-override-');
  const filePath = path.join(root, 'package', 'module.py');
  const override = path.join(root, 'interpreter');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.writeFileSync(override, '');
  assert.equal(resolveInterpreter(root, filePath, { ...cleanEnv, [PYTHON_INTERPRETER_ENV]: override }).interpreter, override);
});

test('locator finds the native TypeScript 7 executable in the project', () => {
  const root = makeTempDir('code-intel-locate-native-');
  const executablePath = plantNativeExecutable(root);
  const recipe = locateLanguageServer(root, cleanEnv);
  assert.equal(recipe.backend, 'typescript-native');
  assert.equal(recipe.command, executablePath);
  assert.deepEqual(recipe.args, ['--lsp', '--stdio']);
});

test('locator prefers the native executable over a wrapper in the same project', () => {
  const root = makeTempDir('code-intel-locate-both-');
  const executablePath = plantNativeExecutable(root);
  plantWrapperCli(root);
  assert.equal(locateLanguageServer(root, cleanEnv).command, executablePath);
});

test('locator finds a project-local typescript-language-server and runs it with node', () => {
  const root = makeTempDir('code-intel-locate-wrapper-');
  const cliPath = plantWrapperCli(root);
  const recipe = locateLanguageServer(root, cleanEnv);
  assert.equal(recipe.backend, 'typescript-language-server');
  assert.equal(recipe.command, process.execPath);
  assert.deepEqual(recipe.args, [cliPath, '--stdio']);
});

test('locator walks up parent directories', () => {
  const parent = makeTempDir('code-intel-locate-parent-');
  const executablePath = plantNativeExecutable(parent);
  const nested = path.join(parent, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(locateLanguageServer(nested, cleanEnv).command, executablePath);
});

test('locator finds a global typescript-language-server through PATH', () => {
  const binDir = makeTempDir('code-intel-locate-global-');
  const shimName = process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server';
  fs.writeFileSync(path.join(binDir, shimName), '');
  const cliPath = plantWrapperCli(binDir);
  const root = makeTempDir('code-intel-locate-empty-');
  const recipe = locateLanguageServer(root, { PATH: binDir });
  assert.equal(recipe.backend, 'typescript-language-server');
  assert.deepEqual(recipe.args, [cliPath, '--stdio']);
});

test('locator reports a clear unavailable message naming an unusable TypeScript 5 install', () => {
  const root = makeTempDir('code-intel-locate-ts5-');
  const typescriptDir = path.join(root, 'node_modules', 'typescript');
  fs.mkdirSync(typescriptDir, { recursive: true });
  fs.writeFileSync(path.join(typescriptDir, 'package.json'), '{"name":"typescript","version":"5.9.3"}');
  const outcome = locateLanguageServer(root, cleanEnv);
  assert.match(outcome.error, /No TypeScript language server is available/);
  assert.ok(outcome.error.includes(typescriptDir));
  assert.match(outcome.error, /npm install -D typescript@latest/);
  assert.match(outcome.error, /npm install -g typescript-language-server/);
});

test('locator env overrides fail loud instead of falling back', () => {
  const root = makeTempDir('code-intel-locate-override-');
  const missing = path.join(root, 'nope', 'tsserver.js');
  const nativeMissing = locateLanguageServer(root, { ...cleanEnv, [NATIVE_SERVER_ENV]: missing });
  assert.ok(nativeMissing.error.includes(NATIVE_SERVER_ENV));
  assert.ok(nativeMissing.error.includes('no fallback'));
  const wrapperMissing = locateLanguageServer(root, { ...cleanEnv, [LANGUAGE_SERVER_ENV]: missing });
  assert.ok(wrapperMissing.error.includes(LANGUAGE_SERVER_ENV));
  const bothSet = locateLanguageServer(root, { ...cleanEnv, [NATIVE_SERVER_ENV]: missing, [LANGUAGE_SERVER_ENV]: missing });
  assert.match(bothSet.error, /unset one/);
});

test('locator honors a real native override', () => {
  const root = makeTempDir('code-intel-locate-override-real-');
  const executablePath = plantNativeExecutable(makeTempDir('code-intel-locate-elsewhere-'));
  const recipe = locateLanguageServer(root, { ...cleanEnv, [NATIVE_SERVER_ENV]: executablePath });
  assert.equal(recipe.backend, 'typescript-native');
  assert.equal(recipe.command, executablePath);
});
