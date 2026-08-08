import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reapMcpSiblings, sidequestMcpProcesses } = require('../src/lib/mcp-process-lifecycle.ts');

test('reaps Sidequest MCP siblings owned by the same Claude process', () => {
  const stopped: number[] = [];
  const reaped = reapMcpSiblings({
    processId: 401,
    parentProcessId: 400,
    listProcesses() {
      return [
        { pid: 401, parentPid: 400, command: 'node sidequest-mcp.js' },
        { pid: 402, parentPid: 400, command: 'node C:/plugins/sidequest/bin/sidequest-mcp.js' },
        { pid: 403, parentPid: 401, command: 'node sidequest-mcp.js' },
        { pid: 404, parentPid: 499, command: 'node C:/plugins/sidequest/bin/sidequest-mcp.js' },
        { pid: 405, parentPid: 400, command: 'node C:/plugins/sidequest/bin/sidequest.js' },
      ];
    },
    killProcess(pid: number) {
      stopped.push(pid);
    },
  });

  assert.deepEqual(reaped, [402]);
  assert.deepEqual(stopped, [402]);
});

test('identifies only Sidequest MCP processes', () => {
  const processes = sidequestMcpProcesses({
    listProcesses() {
      return [
        { pid: 501, parentPid: 500, command: 'node C:/plugins/sidequest/bin/sidequest-mcp.js' },
        { pid: 502, parentPid: 500, command: 'node C:/plugins/sidequest/bin/sidequest.js' },
        { pid: 503, parentPid: 500, command: 'node C:/plugins/other/bin/sidequest-mcp.js.backup' },
      ];
    },
  });

  assert.deepEqual(processes.map((entry: { pid: number }) => entry.pid), [501]);
});
