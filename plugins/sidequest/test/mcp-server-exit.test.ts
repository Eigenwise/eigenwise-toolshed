import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');

type JsonRpcRecord = Record<string, unknown>;

function jsonRpcRecord(value: unknown): value is JsonRpcRecord {
  return value !== null && typeof value === 'object';
}

function waitForJsonMessage(
  server: import('node:child_process').ChildProcess,
  matches: (message: JsonRpcRecord) => boolean,
  timeoutMilliseconds: number,
): Promise<JsonRpcRecord> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      server.kill();
      reject(new Error(`MCP server did not send the expected message within ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    const output = server.stdout;
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        try {
          const message: unknown = JSON.parse(line);
          if (jsonRpcRecord(message) && matches(message)) {
            cleanup();
            resolve(message);
            return;
          }
        } catch (_) {}
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      output?.removeListener('data', onData);
      server.removeListener('error', onError);
    };
    output?.on('data', onData);
    server.once('error', onError);
  });
}

function waitForExit(server: import('node:child_process').ChildProcess, timeoutMilliseconds: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error(`MCP server did not exit within ${timeoutMilliseconds}ms`));
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

function mcpServer(environment: NodeJS.ProcessEnv = process.env) {
  const privateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-mcp-home-'));
  const cleanupPrivateHome = () => fs.rmSync(privateHome, { recursive: true, force: true });
  const server = spawn(process.execPath, [path.resolve(__dirname, '../bin/sidequest-mcp.js')], {
    env: {
      ...environment,
      HOME: privateHome,
      USERPROFILE: privateHome,
      SIDEQUEST_HOME: path.join(privateHome, 'sidequest'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.once('exit', cleanupPrivateHome);
  server.once('error', cleanupPrivateHome);
  return server;
}

function initialize(server: import('node:child_process').ChildProcess) {
  const response = waitForJsonMessage(server, (message) => message.id === 1, 3_000);
  server.stdin?.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'sidequest-test', version: '1.0.0' },
    },
  })}\n`);
  return response;
}

function heartbeatTestEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SIDEQUEST_TEST_MCP_HEARTBEAT_INTERVAL_MILLISECONDS: '20',
    SIDEQUEST_TEST_MCP_HEARTBEAT_TIMEOUT_MILLISECONDS: '40',
    SIDEQUEST_TEST_MCP_INITIALIZATION_DEADLINE_MILLISECONDS: '50',
  };
}

test('MCP server leaves sibling processes alone', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-mcp-sibling-'));
  const siblingPath = path.join(temporaryDirectory, 'sidequest-mcp.js');
  fs.writeFileSync(siblingPath, 'setInterval(() => {}, 1_000);\n');
  const sibling = spawn(process.execPath, [siblingPath], { stdio: 'ignore', windowsHide: true });

  try {
    await once(sibling, 'spawn');
    const server = mcpServer();
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
  const server = mcpServer();

  try {
    server.stdout?.setEncoding('utf8');
    await initialize(server);
    const exit = waitForExit(server, 3_000);
    server.stdin?.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

test('MCP server exits when a client never sends initialized', async () => {
  const server = mcpServer(heartbeatTestEnvironment());

  try {
    server.stdout?.setEncoding('utf8');
    await initialize(server);
    server.stdout?.pause();
    assert.deepEqual(await waitForExit(server, 500), { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

test('MCP server does not let pre-initialization messages extend its deadline', async () => {
  const server = mcpServer(heartbeatTestEnvironment());

  try {
    server.stdout?.setEncoding('utf8');
    await initialize(server);
    server.stdout?.pause();
    const messages = setInterval(() => {
      server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n`);
    }, 10);
    try {
      assert.deepEqual(await waitForExit(server, 500), { code: 0, signal: null });
    } finally {
      clearInterval(messages);
    }
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

test('MCP server exits when an initialized client keeps stdin open but abandons the session', async () => {
  const server = mcpServer(heartbeatTestEnvironment());

  try {
    server.stdout?.setEncoding('utf8');
    await initialize(server);
    server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    server.stdout?.pause();
    assert.deepEqual(await waitForExit(server, 500), { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

test('MCP server keeps an initialized client alive beyond its initialization deadline when it answers heartbeats', async () => {
  const server = mcpServer(heartbeatTestEnvironment());

  try {
    server.stdout?.setEncoding('utf8');
    let heartbeatCount = 0;
    const answeredHeartbeats = new Promise<void>((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('MCP server did not send four heartbeats to its idle client'));
      }, 500);
      const output = server.stdout;
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          try {
            const message: unknown = JSON.parse(line);
            if (jsonRpcRecord(message) && message.method === 'ping') {
              heartbeatCount += 1;
              server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
              if (heartbeatCount === 4) {
                cleanup();
                resolve();
                return;
              }
            }
          } catch (_) {}
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        output?.removeListener('data', onData);
      };
      output?.on('data', onData);
    });

    await initialize(server);
    server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await answeredHeartbeats;
    assert.equal(server.exitCode, null);
    const exit = waitForExit(server, 3_000);
    server.stdin?.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
  }
});
