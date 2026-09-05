#!/usr/bin/env node
"use strict";
const mcp = require("../lib/mcp.js");
const CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS = 6e4;
const CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS = 1e4;
const CLIENT_INITIALIZATION_DEADLINE_MILLISECONDS = 7e4;
function positiveMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function clientConnectionTiming() {
  if (process.env.NODE_ENV !== "test") {
    return {
      intervalMilliseconds: CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS,
      timeoutMilliseconds: CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS,
      initializationDeadlineMilliseconds: CLIENT_INITIALIZATION_DEADLINE_MILLISECONDS
    };
  }
  return {
    intervalMilliseconds: positiveMilliseconds(
      process.env.SIDEQUEST_TEST_MCP_HEARTBEAT_INTERVAL_MILLISECONDS,
      CLIENT_HEARTBEAT_INTERVAL_MILLISECONDS
    ),
    timeoutMilliseconds: positiveMilliseconds(
      process.env.SIDEQUEST_TEST_MCP_HEARTBEAT_TIMEOUT_MILLISECONDS,
      CLIENT_HEARTBEAT_TIMEOUT_MILLISECONDS
    ),
    initializationDeadlineMilliseconds: positiveMilliseconds(
      process.env.SIDEQUEST_TEST_MCP_INITIALIZATION_DEADLINE_MILLISECONDS,
      CLIENT_INITIALIZATION_DEADLINE_MILLISECONDS
    )
  };
}
function jsonRpcRecord(value) {
  return value !== null && typeof value === "object";
}
function writeMessage(message) {
  if (message == null) return;
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch (_) {
  }
}
function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return [];
  try {
    const message = JSON.parse(trimmed);
    return Array.isArray(message) ? message : [message];
  } catch (_) {
    return [];
  }
}
function main() {
  const pending = /* @__PURE__ */ new Set();
  const timing = clientConnectionTiming();
  let buffer = "";
  let shuttingDown = false;
  let clientInitialized = false;
  let heartbeatIdentifier = 0;
  let pendingHeartbeatIdentifier = null;
  let initializationDeadline;
  let heartbeatTimer;
  let heartbeatTimeout;
  const stopClientHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimer = void 0;
    heartbeatTimeout = void 0;
    pendingHeartbeatIdentifier = null;
  };
  const stopClientInitializationDeadline = () => {
    if (initializationDeadline) clearTimeout(initializationDeadline);
    initializationDeadline = void 0;
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopClientInitializationDeadline();
    stopClientHeartbeat();
    if (buffer.trim()) handleLine(buffer);
    await Promise.allSettled(Array.from(pending));
    process.exit(0);
  };
  const startClientInitializationDeadline = () => {
    initializationDeadline = setTimeout(() => {
      initializationDeadline = void 0;
      void shutdown();
    }, timing.initializationDeadlineMilliseconds);
    initializationDeadline.unref();
  };
  const scheduleClientHeartbeat = () => {
    if (shuttingDown || !clientInitialized || pendingHeartbeatIdentifier !== null) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = void 0;
      if (shuttingDown || !clientInitialized || pendingHeartbeatIdentifier !== null) return;
      pendingHeartbeatIdentifier = `sidequest-heartbeat-${++heartbeatIdentifier}`;
      writeMessage({ jsonrpc: "2.0", id: pendingHeartbeatIdentifier, method: "ping" });
      heartbeatTimeout = setTimeout(() => {
        heartbeatTimeout = void 0;
        void shutdown();
      }, timing.timeoutMilliseconds);
      heartbeatTimeout.unref();
    }, timing.intervalMilliseconds);
    heartbeatTimer.unref();
  };
  const clientMessageRestoresHeartbeat = (message) => {
    if (!jsonRpcRecord(message) || message.jsonrpc !== "2.0") return false;
    if (pendingHeartbeatIdentifier !== null && message.id === pendingHeartbeatIdentifier && !("method" in message)) {
      pendingHeartbeatIdentifier = null;
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = void 0;
      scheduleClientHeartbeat();
      return true;
    }
    if (clientInitialized) {
      stopClientHeartbeat();
      scheduleClientHeartbeat();
    }
    if (message.method === "notifications/initialized") {
      stopClientInitializationDeadline();
      clientInitialized = true;
      scheduleClientHeartbeat();
    }
    return false;
  };
  const dispatchMessage = (message) => {
    const operation = Promise.resolve(mcp.handleRequest(message)).then(
      (response) => {
        writeMessage(response);
      },
      () => void 0
    );
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  const handleLine = (line) => {
    for (const message of parseLine(line)) {
      if (!clientMessageRestoresHeartbeat(message)) dispatchMessage(message);
    }
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
  startClientInitializationDeadline();
}
main();
