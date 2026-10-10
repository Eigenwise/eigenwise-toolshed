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
  // Several tests keep writing to stdin while waiting for the server to exit on its own;
  // a write that lands after the child closed the pipe is EPIPE, not a failure.
  server.stdin?.on('error', () => {});
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

function heartbeatTestEnvironment(heartbeatTimeoutMilliseconds = 40): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SIDEQUEST_TEST_MCP_HEARTBEAT_INTERVAL_MILLISECONDS: '20',
    SIDEQUEST_TEST_MCP_HEARTBEAT_TIMEOUT_MILLISECONDS: String(heartbeatTimeoutMilliseconds),
    SIDEQUEST_TEST_MCP_INITIALIZATION_DEADLINE_MILLISECONDS: '50',
  };
}

function splitFrames(text: string) {
  const lines = text.split('\n');
  const rest = lines.pop() ?? '';
  return { lines, rest };
}

function pingFrom(line: string): JsonRpcRecord | undefined {
  try {
    const message: unknown = JSON.parse(line);
    return jsonRpcRecord(message) && message.method === 'ping' ? message : undefined;
  } catch (_) {
    return undefined;
  }
}

function answerHeartbeats(server: import('node:child_process').ChildProcess, count: number, timeoutMilliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    let buffer = '';
    let answered = 0;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP server did not send ${count} heartbeats to its idle client`));
    }, timeoutMilliseconds);
    const output = server.stdout;
    const onData = (chunk: Buffer | string) => {
      const frames = splitFrames(buffer + String(chunk));
      buffer = frames.rest;
      for (const line of frames.lines) {
        const ping = pingFrom(line);
        if (!ping) continue;
        answered += 1;
        server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: ping.id, result: {} })}\n`);
        if (answered === count) {
          cleanup();
          resolve();
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      output?.removeListener('data', onData);
    };
    output?.on('data', onData);
  });
}

function collectStderr(server: import('node:child_process').ChildProcess) {
  let text = '';
  server.stderr?.setEncoding('utf8');
  server.stderr?.on('data', (chunk: string) => { text += chunk; });
  return () => text;
}

// The preload blocks the server's event loop right after the first ping goes out, so the client's answer
// sits unread in stdin while the heartbeat deadline passes, as it does when a slow handler holds the loop.
function blockedLoopEnvironment(blockMilliseconds: number) {
  const preloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-mcp-block-'));
  const preload = path.join(preloadDirectory, 'block-after-first-ping.js');
  fs.writeFileSync(preload, [
    'const write = process.stdout.write.bind(process.stdout);',
    'let blocked = false;',
    'process.stdout.write = (chunk, ...rest) => {',
    '  const written = write(chunk, ...rest);',
    '  if (!blocked && String(chunk).includes(\'"method":"ping"\')) {',
    '    blocked = true;',
    `    setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMilliseconds}));`,
    '  }',
    '  return written;',
    '};',
    '',
  ].join('\n'));
  return {
    environment: { ...heartbeatTestEnvironment(), NODE_OPTIONS: `--require ${preload}` },
    cleanup: () => fs.rmSync(preloadDirectory, { recursive: true, force: true }),
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
  // This test proves a live client survives, not how fast the server reaps a dead one, so the reap
  // timeout and the overall deadline are sized for a loaded machine: a slow test process must still
  // answer in time, and process start must not eat the window the four heartbeats need.
  const server = mcpServer(heartbeatTestEnvironment(2_000));

  try {
    server.stdout?.setEncoding('utf8');
    const answeredHeartbeats = answerHeartbeats(server, 4, 10_000);
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

test('MCP server keeps a live client whose heartbeat answer is waiting in stdin when the deadline passes', async () => {
  const blockedLoop = blockedLoopEnvironment(300);
  const server = mcpServer(blockedLoop.environment);

  try {
    server.stdout?.setEncoding('utf8');
    const answeredHeartbeats = answerHeartbeats(server, 2, 3_000);
    await initialize(server);
    server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await answeredHeartbeats;
    assert.equal(server.exitCode, null);
    const exit = waitForExit(server, 3_000);
    server.stdin?.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
  } finally {
    if (server.exitCode === null) server.kill();
    blockedLoop.cleanup();
  }
});

test('MCP server names the missed ping on stderr when it reaps an abandoned client', async () => {
  const server = mcpServer(heartbeatTestEnvironment());

  try {
    const stderr = collectStderr(server);
    server.stdout?.setEncoding('utf8');
    await initialize(server);
    server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    server.stdout?.pause();
    assert.deepEqual(await waitForExit(server, 500), { code: 0, signal: null });
    assert.match(stderr(), /^sidequest-mcp: no answer to ping sidequest-heartbeat-1 after \d+ms; shutting down$/m);
  } finally {
    if (server.exitCode === null) server.kill();
  }
});
