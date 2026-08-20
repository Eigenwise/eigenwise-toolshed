#!/usr/bin/env node
"use strict";
const mcp = require("../lib/mcp.js");
const pending = /* @__PURE__ */ new Set();
function writeMessage(obj) {
  if (obj == null) return;
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (_) {
  }
}
function dispatchMessage(message) {
  const operation = Promise.resolve(mcp.handleRequest(message)).then(writeMessage, () => void 0);
  pending.add(operation);
  void operation.finally(() => pending.delete(operation));
}
function handleLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  let message;
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
  let buffer = "";
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (buffer.trim()) handleLine(buffer);
    await Promise.allSettled(Array.from(pending));
    process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.stdin.resume();
}
main();
