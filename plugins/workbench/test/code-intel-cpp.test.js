'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { languageForFile } = require('../lib/code-intel/language-server-locator.js');
const cpp = require('../lib/code-intel/language-server-locators/cpp.js');

function makeCppProject() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-cpp-'));
  const sourcePath = path.join(rootDir, 'main.cpp');
  const compilerPath = process.execPath;
  fs.writeFileSync(sourcePath, 'int value() { return 1; }\n');
  fs.writeFileSync(path.join(rootDir, 'CMakeLists.txt'), 'project(test)\n');
  const databasePath = path.join(rootDir, 'compile_commands.json');
  fs.writeFileSync(databasePath, JSON.stringify([{
    directory: rootDir,
    file: sourcePath,
    arguments: [compilerPath, '-c', sourcePath],
  }]));
  return { rootDir, sourcePath, databasePath };
}

test('C++ extensions select the clangd locator', () => {
  for (const extension of ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h', '.c']) {
    assert.equal(languageForFile(`source${extension}`), 'cpp');
  }
});

test('C++ compile databases must cover the queried translation unit', () => {
  const project = makeCppProject();
  assert.equal(cpp.validateFile(project.rootDir, project.sourcePath, { PATH: '' }).error, undefined);
  const missingPath = path.join(project.rootDir, 'other.cpp');
  fs.writeFileSync(missingPath, 'int other;\n');
  assert.match(cpp.validateFile(project.rootDir, missingPath, { PATH: '' }).error, /does not cover/);
});

test('C++ code intelligence refuses missing and stale compile databases with the regenerate command', () => {
  const project = makeCppProject();
  fs.unlinkSync(project.databasePath);
  const missing = cpp.validateFile(project.rootDir, project.sourcePath, { PATH: '' });
  assert.match(missing.error, /needs a current compile_commands\.json/);
  assert.match(missing.error, new RegExp(cpp.REGENERATE_COMMAND_ENV));
  assert.doesNotMatch(missing.error, /--preset \S/);

  const configured = cpp.validateFile(project.rootDir, project.sourcePath, { PATH: '', [cpp.REGENERATE_COMMAND_ENV]: 'cmake --preset local-dev' });
  assert.match(configured.error, /Run cmake --preset local-dev to regenerate it\./);

  fs.writeFileSync(project.databasePath, JSON.stringify([{ directory: project.rootDir, file: project.sourcePath, arguments: [process.execPath, '-c', project.sourcePath] }]));
  fs.utimesSync(path.join(project.rootDir, 'CMakeLists.txt'), new Date(), new Date(Date.now() + 5_000));
  assert.match(cpp.validateFile(project.rootDir, project.sourcePath, { PATH: '' }).error, /CMakeLists\.txt is newer/);
});
