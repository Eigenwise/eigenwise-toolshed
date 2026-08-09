'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_SERVER_ENV = 'WORKBENCH_CODE_INTEL_NATIVE_SERVER';
const LANGUAGE_SERVER_ENV = 'WORKBENCH_CODE_INTEL_LANGUAGE_SERVER';

function nativeServerRecipe(executablePath) {
  return { backend: 'typescript-native', command: executablePath, args: ['--lsp', '--stdio'] };
}

function wrapperServerRecipe(entryPath) {
  const runsWithNode = /\.(?:mjs|cjs|js)$/i.test(entryPath);
  return {
    backend: 'typescript-language-server',
    command: runsWithNode ? process.execPath : entryPath,
    args: runsWithNode ? [entryPath, '--stdio'] : ['--stdio'],
  };
}

function nativeExecutableIn(nodeModulesDir) {
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  for (const packageBase of ['typescript', 'native-preview']) {
    const platformPackageLib = path.join(
      nodeModulesDir,
      '@typescript',
      `${packageBase}-${process.platform}-${process.arch}`,
      'lib',
    );
    for (const binaryName of ['tsc', 'tsgo']) {
      const candidate = path.join(platformPackageLib, binaryName + executableSuffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function wrapperCliIn(nodeModulesDir) {
  const candidate = path.join(nodeModulesDir, 'typescript-language-server', 'lib', 'cli.mjs');
  return fs.existsSync(candidate) ? candidate : null;
}

function globalWrapperServer(env) {
  const pathValue = env.PATH || env.Path || '';
  const shimNames = process.platform === 'win32'
    ? ['typescript-language-server.cmd', 'typescript-language-server']
    : ['typescript-language-server'];
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const shimName of shimNames) {
      const shim = path.join(entry, shimName);
      if (!fs.existsSync(shim)) continue;
      const adjacentCli = wrapperCliIn(path.join(entry, 'node_modules'));
      if (adjacentCli) return wrapperServerRecipe(adjacentCli);
      if (process.platform !== 'win32') {
        try {
          return wrapperServerRecipe(fs.realpathSync(shim));
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

function locateLanguageServer(rootDir, env = process.env) {
  const nativeOverride = env[NATIVE_SERVER_ENV];
  const wrapperOverride = env[LANGUAGE_SERVER_ENV];
  if (nativeOverride && wrapperOverride) {
    return { error: `Both ${NATIVE_SERVER_ENV} and ${LANGUAGE_SERVER_ENV} are set; unset one of them — there is no implicit preference between overrides.` };
  }
  if (nativeOverride) {
    if (!fs.existsSync(nativeOverride)) {
      return { error: `${NATIVE_SERVER_ENV} is set to ${nativeOverride}, but that file does not exist. Fix or unset the override; there is no fallback.` };
    }
    return nativeServerRecipe(nativeOverride);
  }
  if (wrapperOverride) {
    if (!fs.existsSync(wrapperOverride)) {
      return { error: `${LANGUAGE_SERVER_ENV} is set to ${wrapperOverride}, but that file does not exist. Fix or unset the override; there is no fallback.` };
    }
    return wrapperServerRecipe(wrapperOverride);
  }
  let unusableTypescriptDir = null;
  let currentDir = rootDir;
  for (;;) {
    const nodeModulesDir = path.join(currentDir, 'node_modules');
    const nativeExecutable = nativeExecutableIn(nodeModulesDir);
    if (nativeExecutable) return nativeServerRecipe(nativeExecutable);
    const wrapperCli = wrapperCliIn(nodeModulesDir);
    if (wrapperCli) return wrapperServerRecipe(wrapperCli);
    if (!unusableTypescriptDir && fs.existsSync(path.join(nodeModulesDir, 'typescript', 'package.json'))) {
      unusableTypescriptDir = path.join(nodeModulesDir, 'typescript');
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  const globalWrapper = globalWrapperServer(env);
  if (globalWrapper) return globalWrapper;
  const unusableNote = unusableTypescriptDir
    ? ` Found ${unusableTypescriptDir}, but that TypeScript version ships no language server this plugin can talk to on its own.`
    : '';
  return {
    error: `No TypeScript language server is available for ${rootDir}.${unusableNote} Install TypeScript 7 in the project (npm install -D typescript@latest), or install typescript-language-server (npm install -g typescript-language-server) to serve TypeScript 5 projects.`,
  };
}

module.exports = { locateLanguageServer, NATIVE_SERVER_ENV, LANGUAGE_SERVER_ENV };
