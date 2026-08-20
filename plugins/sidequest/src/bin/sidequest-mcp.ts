'use strict';
/**
 * sidequest - MCP server (stdio transport)
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests run
 * independently; the MCP layer serializes board mutations where required.
 */

const mcp = require('../lib/mcp.js');

const CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS = 60_000;
const CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS = 10_000;

type HeartbeatTiming = {
  intervalMilliseconds: number;
  timeoutMilliseconds: number;
};

type JsonRpcRecord = Record<string, unknown>;

function positiveMilliseconds(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function heartbeatTiming(): HeartbeatTiming {
  if (process.env.NODE_ENV !== 'test') {
    return {
      intervalMilliseconds: CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS,
      timeoutMilliseconds: CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS,
    };
  }
  return {
    intervalMilliseconds: positiveMilliseconds(
      process.env.SIDEQUEST_TEST_MCP_HEARTBEAT_INTERVAL_MILLISECONDS,
      CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS,
    ),
    timeoutMilliseconds: positiveMilliseconds(
      process.env.SIDEQUEST_TEST_MCP_HEARTBEAT_TIMEOUT_MILLISECONDS,
      CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS,
    ),
  };
}

function jsonRpcRecord(value: unknown): value is JsonRpcRecord {
  return value !== null && typeof value === 'object';
}

function writeMessage(message: unknown) {
  if (message == null) return;
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch (_) {}
}

function parseLine(line: unknown): unknown[] {
  const trimmed = String(line || '').trim();
  if (!trimmed) return [];
  try {
    const message: unknown = JSON.parse(trimmed);
    return Array.isArray(message) ? message : [message];
  } catch (_) {
    return [];
  }
}

function main() {
  const pending = new Set<Promise<void>>();
  const timing = heartbeatTiming();
  let buffer = '';
  let shuttingDown = false;
  let clientInitialized = false;
  let heartbeatIdentifier = 0;
  let pendingHeartbeatIdentifier: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatTimeout: NodeJS.Timeout | undefined;

  const stopClientHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimer = undefined;
    heartbeatTimeout = undefined;
    pendingHeartbeatIdentifier = null;
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopClientHeartbeat();
    if (buffer.trim()) handleLine(buffer);
    await Promise.allSettled(Array.from(pending));
    process.exit(0);
  };

  const scheduleClientHeartbeat = () => {
    if (shuttingDown || !clientInitialized || pendingHeartbeatIdentifier !== null) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      if (shuttingDown || !clientInitialized || pendingHeartbeatIdentifier !== null) return;
      pendingHeartbeatIdentifier = `sidequest-heartbeat-${++heartbeatIdentifier}`;
      writeMessage({ jsonrpc: '2.0', id: pendingHeartbeatIdentifier, method: 'ping' });
      heartbeatTimeout = setTimeout(() => {
        heartbeatTimeout = undefined;
        void shutdown();
      }, timing.timeoutMilliseconds);
      heartbeatTimeout.unref();
    }, timing.intervalMilliseconds);
    heartbeatTimer.unref();
  };

  const clientMessageRestoresHeartbeat = (message: unknown) => {
    if (!jsonRpcRecord(message) || message.jsonrpc !== '2.0') return false;
    if (pendingHeartbeatIdentifier !== null && message.id === pendingHeartbeatIdentifier && !('method' in message)) {
      pendingHeartbeatIdentifier = null;
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = undefined;
      scheduleClientHeartbeat();
      return true;
    }
    if (clientInitialized) {
      stopClientHeartbeat();
      scheduleClientHeartbeat();
    }
    if (message.method === 'notifications/initialized') {
      clientInitialized = true;
      scheduleClientHeartbeat();
    }
    return false;
  };

  const dispatchMessage = (message: unknown) => {
    const operation: Promise<void> = Promise.resolve(mcp.handleRequest(message)).then(
      (response: unknown) => { writeMessage(response); },
      () => undefined,
    );
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };

  const handleLine = (line: unknown) => {
    for (const message of parseLine(line)) {
      if (!clientMessageRestoresHeartbeat(message)) dispatchMessage(message);
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.stdin.resume();
}

main();
