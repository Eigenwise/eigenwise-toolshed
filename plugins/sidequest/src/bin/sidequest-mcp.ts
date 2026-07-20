'use strict';
/**
 * sidequest - MCP server (stdio transport)
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests run
 * independently; the MCP layer serializes board mutations where required.
 */

const mcp = require('../lib/mcp.js');

const pending = new Set<Promise<void>>();

function writeMessage(obj?: any) {
  if (obj == null) return;
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (_) {}
}

function dispatchMessage(message?: any) {
  const operation = Promise.resolve(mcp.handleRequest(message)).then(writeMessage, () => undefined);
  pending.add(operation);
  void operation.finally(() => pending.delete(operation));
}

function handleLine(line?: any) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return;
  let message: any;
  try {
    message = JSON.parse(trimmed);
  } catch (_) {
    return;
  }
  if (Array.isArray(message)) {
    for (const item of message) dispatchMessage(item);
    return;
  }
  dispatchMessage(message);
}

function main() {
  let buffer = '';
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
  process.stdin.on('end', async () => {
    if (buffer.trim()) handleLine(buffer);
    await Promise.allSettled(Array.from(pending));
    process.exit(0);
  });
  process.stdin.resume();
}

main();
