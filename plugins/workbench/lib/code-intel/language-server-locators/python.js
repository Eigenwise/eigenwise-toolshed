'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PYRIGHT_SERVER_ENV = 'WORKBENCH_CODE_INTEL_PYRIGHT_SERVER';
const PYTHON_INTERPRETER_ENV = 'WORKBENCH_CODE_INTEL_PYTHON_INTERPRETER';

function languageIdFor() {
  return 'python';
}

function isUnderDirectory(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function interpreterIn(virtualEnvironmentDir) {
  const executable = process.platform === 'win32'
    ? path.join(virtualEnvironmentDir, 'Scripts', 'python.exe')
    : path.join(virtualEnvironmentDir, 'bin', 'python');
  return fs.existsSync(executable) ? executable : null;
}

function nearestVirtualEnvironment(filePath, rootDir) {
  let currentDir = path.dirname(filePath);
  for (;;) {
    for (const name of ['.venv', 'venv']) {
      const interpreter = interpreterIn(path.join(currentDir, name));
      if (interpreter) return interpreter;
    }
    if (currentDir === rootDir) return null;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !isUnderDirectory(rootDir, parentDir)) return null;
    currentDir = parentDir;
  }
}

function nearestPackageDeclaration(filePath, rootDir) {
  let currentDir = path.dirname(filePath);
  for (;;) {
    if (['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'requirements.txt'].some((name) => fs.existsSync(path.join(currentDir, name)))) {
      return currentDir;
    }
    if (currentDir === rootDir) return null;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !isUnderDirectory(rootDir, parentDir)) return null;
    currentDir = parentDir;
  }
}

function executableOnPath(env) {
  const pathValue = env.PATH || env.Path || '';
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Interpreter selection is ordered: explicit override, VIRTUAL_ENV containing the file,
// nearest .venv or venv from the file to the bound root, package-environment refusal, then PATH discovery.
function resolveInterpreter(rootDir, filePath, env = process.env) {
  const override = env[PYTHON_INTERPRETER_ENV];
  if (override) {
    if (!fs.existsSync(override)) {
      return { error: `${PYTHON_INTERPRETER_ENV} is set to ${override}, but that file does not exist. Fix or unset the override; there is no fallback.` };
    }
    return { interpreter: override };
  }

  const activatedEnvironment = env.VIRTUAL_ENV;
  if (activatedEnvironment && isUnderDirectory(activatedEnvironment, filePath)) {
    const interpreter = interpreterIn(activatedEnvironment);
    if (interpreter) return { interpreter };
  }

  const nearestInterpreter = nearestVirtualEnvironment(filePath, rootDir);
  if (nearestInterpreter) return { interpreter: nearestInterpreter };

  const packageDirectory = nearestPackageDeclaration(filePath, rootDir);
  if (packageDirectory) {
    return {
      error: `Python package ${packageDirectory} declares dependencies with no environment to resolve them against. Create a virtual environment in ${packageDirectory} or set ${PYTHON_INTERPRETER_ENV}.`,
    };
  }

  const discoveredInterpreter = executableOnPath(env);
  if (discoveredInterpreter) return { interpreter: discoveredInterpreter };

  return {
    error: `No Python interpreter is available for ${filePath}. Searched ${PYTHON_INTERPRETER_ENV}, VIRTUAL_ENV for this file, .venv and venv from the file up to ${rootDir}, and python on PATH. Create a package virtual environment, activate the matching environment, or set ${PYTHON_INTERPRETER_ENV}.`,
  };
}

function pyrightRecipe(serverPath, interpreter) {
  const runsWithNode = /\.(?:mjs|cjs|js)$/i.test(serverPath);
  return {
    backend: 'pyright',
    command: runsWithNode ? process.execPath : serverPath,
    args: runsWithNode ? [serverPath, '--stdio'] : ['--stdio'],
    initializationOptions: {},
    workspaceConfiguration: { python: { pythonPath: interpreter } },
    languageIdFor,
    serverKey: fs.realpathSync.native(interpreter),
  };
}

function projectServer(rootDir) {
  let currentDir = rootDir;
  for (;;) {
    const candidate = path.join(currentDir, 'node_modules', 'pyright', 'langserver.index.js');
    if (fs.existsSync(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function globalServer(env) {
  const pathValue = env.PATH || env.Path || '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const adjacentServer = path.join(directory, 'node_modules', 'pyright', 'langserver.index.js');
    if (fs.existsSync(adjacentServer)) return adjacentServer;
    if (process.platform !== 'win32') {
      const shim = path.join(directory, 'pyright-langserver');
      if (fs.existsSync(shim)) return shim;
    }
  }
  return null;
}

function locate(rootDir, env = process.env, filePath) {
  const serverOverride = env[PYRIGHT_SERVER_ENV];
  if (serverOverride && !fs.existsSync(serverOverride)) {
    return { error: `${PYRIGHT_SERVER_ENV} is set to ${serverOverride}, but that file does not exist. Fix or unset the override; there is no fallback.` };
  }
  const interpreterResolution = resolveInterpreter(rootDir, filePath || rootDir, env);
  if (interpreterResolution.error) return interpreterResolution;
  const server = serverOverride || projectServer(rootDir) || globalServer(env);
  if (!server) {
    return { error: `No pyright-langserver is available for ${rootDir}. Install pyright in the project (npm install -D pyright), install pyright globally (npm install -g pyright), or set ${PYRIGHT_SERVER_ENV}.` };
  }
  return pyrightRecipe(server, interpreterResolution.interpreter);
}

module.exports = {
  extensions: ['.py', '.pyi'],
  locate,
  resolveInterpreter,
  PYRIGHT_SERVER_ENV,
  PYTHON_INTERPRETER_ENV,
};
