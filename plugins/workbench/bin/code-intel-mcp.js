#!/usr/bin/env node
'use strict';

const {
  handleRequest,
  parseMessage,
  oversizedRequestLineError,
  MAX_REQUEST_CHARS,
} = require('../lib/code-intel/mcp.js');
const { shutdownAll } = require('../lib/code-intel/project-registry.js');

const pending = new Set();

function writeMessage(message) {
  if (message == null) return;
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch {}
}

function dispatchMessage(message) {
  const operation = Promise.resolve(handleRequest(message)).then(writeMessage, () => undefined);
  pending.add(operation);
  void operation.finally(() => pending.delete(operation));
}

function handleLine(line) {
  if (line.length > MAX_REQUEST_CHARS) {
    writeMessage(oversizedRequestLineError());
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) return;
  const message = parseMessage(trimmed);
  if (message === undefined) return;
  if (Array.isArray(message)) {
    for (const item of message) dispatchMessage(item);
    return;
  }
  dispatchMessage(message);
}

function main() {
  let buffered = '';
  let discardingRefusedLine = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    let arrived = chunk;
    // A line already refused for its length is dropped byte for byte until it
    // ends, so it is never buffered again and never refused twice.
    if (discardingRefusedLine) {
      const lineEnd = arrived.indexOf('\n');
      if (lineEnd === -1) return;
      discardingRefusedLine = false;
      arrived = arrived.slice(lineEnd + 1);
    }
    buffered += arrived;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
    // Complete lines are drained first, so what is left is one unfinished
    // line: past the bound it is refused here, before the next chunk could
    // grow it further and before any of it reaches the parser.
    if (buffered.length > MAX_REQUEST_CHARS) {
      writeMessage(oversizedRequestLineError());
      discardingRefusedLine = true;
      buffered = '';
    }
  });
  process.stdin.on('end', async () => {
    if (!discardingRefusedLine && buffered.trim()) handleLine(buffered);
    await Promise.allSettled([...pending]);
    shutdownAll();
    process.exit(0);
  });
  process.on('exit', () => {
    try {
      shutdownAll();
    } catch {}
  });
}

main();
