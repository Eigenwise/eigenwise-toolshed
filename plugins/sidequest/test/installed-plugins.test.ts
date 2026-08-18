import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSidequestInstall } from '../src/lib/dispatch-preflight.js';
import { writeInstalledPluginsAtomically } from '../src/lib/installed-plugins.js';

const pluginRegistryModulePath = path.join(__dirname, '..', 'src', 'lib', 'installed-plugins.ts');
const pluginId = 'sidequest@eigenwise-toolshed';

function writeRegistry(registryPath: string, installPath: string): void {
  writeInstalledPluginsAtomically(registryPath, JSON.stringify({
    plugins: {
      [pluginId]: [{ scope: 'user', installPath, version: 'test' }],
    },
  }));
}

function runRegistryWriter(registryPath: string, installPath: string, injectWindowsLockContention = false): Promise<void> {
  const writer = spawn(process.execPath, ['--import', 'tsx', '--eval', `
    const registryPath = process.env.SQ_REGISTRY_PATH;
    const installPath = process.env.SQ_INSTALL_PATH;
    if (process.env.SQ_INJECT_WINDOWS_LOCK_CONTENTION === '1') {
      const fs = require('node:fs');
      const openSync = fs.openSync;
      let shouldInjectWindowsLockContention = true;
      fs.openSync = (...openArguments) => {
        if (shouldInjectWindowsLockContention && openArguments[0] === \`\${registryPath}.lock\` && openArguments[1] === 'wx') {
          shouldInjectWindowsLockContention = false;
          const error = new Error('simulated Windows registry lock contention');
          error.code = 'EPERM';
          throw error;
        }
        return openSync(...openArguments);
      };
      require('node:module').syncBuiltinESMExports();
    }
    const { writeInstalledPluginsAtomically } = require(${JSON.stringify(pluginRegistryModulePath)});
    for (let index = 0; index < 80; index += 1) {
      writeInstalledPluginsAtomically(registryPath, JSON.stringify({
        plugins: {
          'sidequest@eigenwise-toolshed': [{ scope: 'user', installPath, version: String(index) }],
        },
        padding: 'x'.repeat(131072),
      }));
    }
  `], {
    env: {
      ...process.env,
      SQ_INJECT_WINDOWS_LOCK_CONTENTION: injectWindowsLockContention ? '1' : '0',
      SQ_REGISTRY_PATH: registryPath,
      SQ_INSTALL_PATH: installPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let errorOutput = '';
    writer.stderr?.setEncoding('utf8');
    writer.stderr?.on('data', (chunk: string) => { errorOutput += chunk; });
    writer.once('error', reject);
    writer.once('exit', (exitCode, signal) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`registry writer exited ${exitCode ?? 'null'} (${signal ?? 'no signal'}): ${errorOutput}`));
    });
  });
}

test('atomic registry fixture writes keep lockfile-overlap dispatch preflight readable', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-plugins-'));
  const claudeHome = path.join(temporaryDirectory, 'claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const installPath = path.join(temporaryDirectory, 'install');
  const projectPath = path.join(temporaryDirectory, 'project');
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: {} } }));
  writeRegistry(registryPath, installPath);

  let readerRuns = 0;
  let readFailure: Error | undefined;
  const reader = setInterval(() => {
    readerRuns += 1;
    const check = checkSidequestInstall(projectPath, { claudeHome });
    if (!check.ok) readFailure = new Error(`dispatch preflight returned ${check.reason ?? 'an unknown failure'}: ${check.detail ?? ''}`);
  }, 0);

  try {
    await Promise.all([runRegistryWriter(registryPath, installPath, true), runRegistryWriter(registryPath, installPath)]);
  } finally {
    clearInterval(reader);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  assert.ok(readerRuns > 0, 'concurrent writers left no interval for a dispatch preflight read');
  assert.ifError(readFailure);
});

test('dispatch preflight retries transient plugin registry read errors', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-plugins-retry-'));
  const claudeHome = path.join(temporaryDirectory, 'claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const installPath = path.join(temporaryDirectory, 'install');
  const projectPath = path.join(temporaryDirectory, 'project');
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: {} } }));
  writeRegistry(registryPath, installPath);

  const originalReadFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFileSync')!;
  const originalReadFileSync = fs.readFileSync;
  let registryReadAttempts = 0;
  Object.defineProperty(fs, 'readFileSync', {
    ...originalReadFileSyncDescriptor,
    value: function (...arguments_: unknown[]) {
      if (arguments_[0] === registryPath && registryReadAttempts < 2) {
        registryReadAttempts += 1;
        throw Object.assign(new Error('simulated transient registry read failure'), { code: 'EPERM' });
      }
      if (arguments_[0] === registryPath) registryReadAttempts += 1;
      return Reflect.apply(originalReadFileSync, fs, arguments_);
    },
  });

  try {
    const check = checkSidequestInstall(projectPath, { claudeHome });
    assert.equal(check.ok, true);
    assert.equal(registryReadAttempts, 3);
  } finally {
    Object.defineProperty(fs, 'readFileSync', originalReadFileSyncDescriptor);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dispatch preflight does not retry non-retryable plugin registry read errors', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-installed-plugins-no-retry-'));
  const claudeHome = path.join(temporaryDirectory, 'claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const originalReadFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFileSync')!;
  const originalReadFileSync = fs.readFileSync;
  let registryReadAttempts = 0;
  Object.defineProperty(fs, 'readFileSync', {
    ...originalReadFileSyncDescriptor,
    value: function (...arguments_: unknown[]) {
      if (arguments_[0] === registryPath) {
        registryReadAttempts += 1;
        throw Object.assign(new Error('simulated directory read failure'), { code: 'EISDIR' });
      }
      return Reflect.apply(originalReadFileSync, fs, arguments_);
    },
  });

  try {
    const check = checkSidequestInstall('/project', { claudeHome });
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'registry_unreadable');
    assert.equal(registryReadAttempts, 1);
  } finally {
    Object.defineProperty(fs, 'readFileSync', originalReadFileSyncDescriptor);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
