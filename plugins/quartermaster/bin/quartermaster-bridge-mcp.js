#!/usr/bin/env node
'use strict';

const { StringDecoder } = require('node:string_decoder');
const { createMcp } = require('../lib/host-bridge-mcp.js');

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--project') throw new Error('Usage: node quartermaster-bridge-mcp.js --project <absolute-existing-project>. The MCP server must pin its project.');
  const server = createMcp({ project: argv[1] });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let shuttingDown = false;
  let oversized = false;
  const pending = new Set();
  const write = (value) => { if (value && !process.stdout.destroyed) process.stdout.write(`${JSON.stringify(value)}\n`); };
  const line = (value) => {
    if (!value.trim()) return;
    let message;
    try { message = JSON.parse(value); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
    const promise = server.handle(message).then(write).catch(() => write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: 'Bridge request failed.' } }));
    pending.add(promise); void promise.finally(() => pending.delete(promise));
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdin.pause();
    await Promise.allSettled([...pending]);
    await server.close();
  };
  process.stdin.on('data', (chunk) => {
    if (shuttingDown) return;
    buffer += decoder.write(chunk);
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const value = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!oversized && Buffer.byteLength(value) <= 512 * 1024) line(value);
      else write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bridge request exceeded its 512KiB limit.' } });
      oversized = false;
    }
    if (Buffer.byteLength(buffer) > 512 * 1024) { buffer = ''; oversized = true; }
  });
  process.stdin.once('end', () => { buffer += decoder.end(); if (buffer.trim() && !oversized) line(buffer); void shutdown(); });
  process.stdin.once('error', () => { void shutdown(); });
  process.stdout.on('error', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
