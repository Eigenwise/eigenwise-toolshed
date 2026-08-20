import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');

function waitForResponse(server: import('node:child_process').ChildProcess, timeoutMilliseconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error(`MCP server did not answer within ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    server.stdout?.once('data', (chunk: Buffer | string) => {
      clearTimeout(timeout);
      resolve(String(chunk));
    });
    server.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForExit(server: import('node:child_process').ChildProcess, timeoutMilliseconds: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error(`MCP server did not exit within ${timeoutMilliseconds}ms after stdin closed`));
    }, timeoutMilliseconds);
    server.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    server.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('MCP server leaves sibling processes alone', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-mcp-sibling-'));
  const siblingPath = path.join(temporaryDirectory, 'sidequest-mcp.js');
  fs.writeFileSync(siblingPath, 'setInterval(() => {}, 1_000);\n');
  const sibling = spawn(process.execPath, [siblingPath], { stdio: 'ignore', windowsHide: true });

  try {
    await once(sibling, 'spawn');
    const server = spawn(process.execPath, [path.resolve(__dirname, '../bin/sidequest-mcp.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      server.stdin?.end();
      assert.deepEqual(await waitForExit(server, 3_000), { code: 0, signal: null });
      assert.equal(sibling.exitCode, null);
    } finally {
      if (server.exitCode === null) server.kill();
    }
  } finally {
    if (sibling.exitCode === null) sibling.kill();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('MCP server exits after its client closes stdin', async () => {
  const server = spawn(process.execPath, [path.resolve(__dirname, '../bin/sidequest-mcp.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    server.stdout?.setEncoding('utf8');
    const response = waitForResponse(server, 3_000);
    server.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sidequest-test', version: '1.0.0' },
      },
    })}\n`);

    assert.match(await response, /"id":1/);
    const exit = waitForExit(server, 3_000);
    server.stdin?.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
  }
});
