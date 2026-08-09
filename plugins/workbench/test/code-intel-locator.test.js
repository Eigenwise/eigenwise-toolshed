'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { locateLanguageServer, NATIVE_SERVER_ENV, LANGUAGE_SERVER_ENV } = require('../lib/code-intel/language-server-locator.js');

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
