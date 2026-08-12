'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LANGUAGE_SERVER_ENV = 'WORKBENCH_CODE_INTEL_CPP_LANGUAGE_SERVER';
const COMPILE_COMMANDS_ENV = 'WORKBENCH_CODE_INTEL_CPP_COMPILE_COMMANDS';
const REGENERATE_COMMAND = 'cmake --preset ninja-release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON';
const MINIMUM_CLANGD_MAJOR_VERSION = 16;

function languageIdFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.c' ? 'c' : 'cpp';
}

function clangdRecipe(executablePath, compileCommandsPath) {
  return {
    backend: 'clangd',
    command: executablePath,
    args: ['--stdio', '--background-index', `--compile-commands-dir=${path.dirname(compileCommandsPath)}`],
    languageIdFor,
  };
}

function executableNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

function executableFromPath(name, env) {
  const pathValue = env.PATH || env.Path || '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const executableName of executableNames(name)) {
      const candidate = path.join(directory, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function bundledClangd() {
  for (const directory of ['C:/Program Files/LLVM/bin', 'C:/Program Files (x86)/LLVM/bin']) {
    for (const executableName of executableNames('clangd')) {
      const candidate = path.join(directory, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function clangdVersion(executablePath) {
  const version = childProcess.spawnSync(executablePath, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) return null;
  const match = /clangd version (\d+)/i.exec(`${version.stdout}\n${version.stderr}`);
  return match ? Number.parseInt(match[1], 10) : null;
}

function compileCommandsPath(rootDir, env) {
  const configuredPath = env[COMPILE_COMMANDS_ENV];
  return configuredPath ? path.resolve(configuredPath) : path.join(rootDir, 'compile_commands.json');
}

function repairMessage(databasePath, problem) {
  return `C++ code intelligence needs a current compile_commands.json at ${databasePath}. ${problem} Run ${REGENERATE_COMMAND} to regenerate it; Workbench never runs CMake or a build for a query.`;
}

function commandExecutable(command) {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command.trim());
  return match ? (match[1] || match[2] || match[3]) : null;
}

function commandPathResolves(command, directory, env) {
  if (!command) return false;
  if (path.isAbsolute(command)) return fs.existsSync(command);
  if (command.includes('/') || command.includes('\\')) return fs.existsSync(path.resolve(directory, command));
  return Boolean(executableFromPath(command, env));
}

function validateCompileCommands(rootDir, filePath, env = process.env) {
  const databasePath = compileCommandsPath(rootDir, env);
  let databaseStat;
  try {
    databaseStat = fs.statSync(databasePath);
  } catch {
    return { error: repairMessage(databasePath, 'The database is missing or unreadable.') };
  }
  if (!databaseStat.isFile()) return { error: repairMessage(databasePath, 'The database path is not a file.') };
  let commands;
  try {
    commands = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  } catch {
    return { error: repairMessage(databasePath, 'The database is not parseable JSON.') };
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    return { error: repairMessage(databasePath, 'The database has no translation units.') };
  }
  if (filePath) {
    const queryPath = fs.realpathSync.native(filePath);
    let queryCommand = null;
    for (const command of commands) {
      if (!command || typeof command.file !== 'string' || typeof command.directory !== 'string') continue;
      const sourcePath = path.resolve(command.directory, command.file);
      try {
        if (fs.realpathSync.native(sourcePath) === queryPath) {
          queryCommand = command;
          break;
        }
      } catch {}
    }
    if (!queryCommand) {
      return { error: repairMessage(databasePath, `The database does not cover ${filePath}.`) };
    }
    const executable = Array.isArray(queryCommand.arguments) ? queryCommand.arguments[0] : commandExecutable(queryCommand.command || '');
    if (!commandPathResolves(executable, queryCommand.directory, env)) {
      return { error: repairMessage(databasePath, 'The translation unit command path does not resolve.') };
    }
  }
  for (const inputName of ['CMakeLists.txt', 'CMakePresets.json', '.clangd']) {
    const inputPath = path.join(rootDir, inputName);
    try {
      if (fs.statSync(inputPath).mtimeMs > databaseStat.mtimeMs) {
        return { error: repairMessage(databasePath, `${inputName} is newer than the database.`) };
      }
    } catch {}
  }
  return { databasePath };
}

function locate(rootDir, env = process.env) {
  const compileDatabase = validateCompileCommands(rootDir, null, env);
  if (compileDatabase.error) return compileDatabase;
  const override = env[LANGUAGE_SERVER_ENV];
  const executablePath = override || executableFromPath('clangd', env) || bundledClangd();
  if (override && !fs.existsSync(override)) {
    return { error: `${LANGUAGE_SERVER_ENV} is set to ${override}, but that file does not exist. Fix or unset the override; there is no fallback.` };
  }
  if (!executablePath) {
    return { error: `No clangd executable is available for ${rootDir}. Set ${LANGUAGE_SERVER_ENV}, add clangd to PATH, or install LLVM.` };
  }
  const majorVersion = clangdVersion(executablePath);
  if (majorVersion === null || majorVersion < MINIMUM_CLANGD_MAJOR_VERSION) {
    return { error: `clangd at ${executablePath} must report version ${MINIMUM_CLANGD_MAJOR_VERSION} or newer because Workbench uses LSP work-done progress and pull code-intelligence requests.` };
  }
  return clangdRecipe(executablePath, compileDatabase.databasePath || compileCommandsPath(rootDir, env));
}

function validateFile(rootDir, filePath, env = process.env) {
  return validateCompileCommands(rootDir, filePath, env);
}

module.exports = {
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h', '.c'],
  locate,
  validateFile,
  languageIdFor,
  LANGUAGE_SERVER_ENV,
  COMPILE_COMMANDS_ENV,
  REGENERATE_COMMAND,
  MINIMUM_CLANGD_MAJOR_VERSION,
};
