'use strict';

const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const originalExecuteFile = childProcess.execFile;
const executeFile = promisify(originalExecuteFile);

childProcess.execFile = function executeExternalFile(...argumentsList) {
  return originalExecuteFile(...argumentsList);
};

childProcess.execFile[promisify.custom] = async function authenticatedCodexStatus(file, argumentsList, options) {
  if (JSON.stringify(argumentsList) === JSON.stringify(['codex', 'auth', 'status'])) {
    return { stdout: 'account: isolated-test-fixture', stderr: '' };
  }
  return executeFile(file, argumentsList, options);
};
