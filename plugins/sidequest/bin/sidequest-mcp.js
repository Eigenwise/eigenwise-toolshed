#!/usr/bin/env node
'use strict';
/**
 * sidequest - MCP server (stdio transport)
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP stdio
 * transport — so Claude Code can expose the board as typed tools
 * (mcp__sidequest__claim, …) instead of an agent shelling out to the CLI per
 * action. All the logic (tool registry, request handling) is in lib/mcp.js; this
 * file is just the read-a-line / write-a-line loop.
 *
 * One JSON object per line, both directions. We buffer stdin and dispatch on
 * each complete line; a blank or unparseable line is ignored (a malformed frame
 * must never crash the server). Node stdlib only.
 */

const mcp = require('../lib/mcp');

function writeMessage(obj) {
  if (obj == null) return; // notifications produce no response
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (_) {
    /* a write failure on a closed pipe shouldn't crash us */
  }
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (_) {
    // Not valid JSON — can't even extract an id to answer, so drop it. A
    // conforming client never sends this.
    return;
  }
  // A JSON-RPC batch is an array of messages.
  if (Array.isArray(msg)) {
    for (const m of msg) writeMessage(mcp.handleRequest(m));
    return;
  }
  writeMessage(mcp.handleRequest(msg));
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        handleLine(line);
      } catch (_) {
        /* one bad frame must not take the server down */
      }
    }
  });
  process.stdin.on('end', () => {
    // Flush any trailing line without a newline, then exit when the client closes.
    if (buffer.trim()) {
      try { handleLine(buffer); } catch (_) { /* ignore */ }
    }
    process.exit(0);
  });
  // Keep the process alive on stdin; nothing else to do.
  process.stdin.resume();
}

main();
