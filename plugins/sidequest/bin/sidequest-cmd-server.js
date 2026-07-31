#!/usr/bin/env node
"use strict";
const path = require("path");
const os = require("os");
const fs = require("node:fs/promises");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const store = require("../lib/store");
const agentsync = require("../lib/agentsync");
const work = require("../lib/work");
const commitScope = require("../lib/commit-scope");
const worktrees = require("../lib/worktrees");
const tempCleanup = require("../lib/temp-cleanup");
const execNames = require("../lib/exec-names");
const { claimRefusalMessage } = require("../lib/refusal-guidance");
const { assertSidequestInstall, assertDispatchTransport } = require("../lib/dispatch-preflight");
const { fail, resolveProject } = require("./sidequest-cmd-shared");
let PLUGIN_VERSION = null;
try {
  PLUGIN_VERSION = require("../.claude-plugin/plugin.json").version || null;
} catch (_) {
}
function checkHealth(port, timeoutMs = void 0) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs || 800 }, (res) => {
      let raw = "";
      res.on("data", (c) => raw += c);
      res.on("end", () => {
        try {
          const info = JSON.parse(raw);
          resolve(info && info.name === "sidequest" ? info : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}
async function checkHealthPatient(port, attempts = void 0) {
  for (let i = 0; i < (attempts || 3); i++) {
    const health = await checkHealth(port);
    if (health) return health;
    if (i < (attempts || 3) - 1) await delay(200);
  }
  return null;
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}
function compareVersions(left, right) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(String(value || "")) ? String(value).split(".").map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    const left2 = a[index] ?? 0;
    const rightValue = b[index] ?? 0;
    if (left2 !== rightValue) return left2 - rightValue;
  }
  return 0;
}
function isVersionAtLeast(version, baseline) {
  if (!baseline) return true;
  const comparison = compareVersions(version, baseline);
  return comparison !== null && comparison >= 0;
}
function isRecordedServer(health, info) {
  return Boolean(health && info && Number.isInteger(Number(health.pid)) && Number(health.pid) === Number(info.pid));
}
async function waitForPidExit(pid, timeoutMs = void 0) {
  const deadline = Date.now() + (timeoutMs || 1e4);
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}
async function reapServer(info, health = void 0) {
  if (health && !isRecordedServer(health, info)) return false;
  if (info && info.pid && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch (_) {
      return false;
    }
    if (!await waitForPidExit(info.pid)) return false;
  }
  const current = store.readServerInfo();
  if (current && current.pid === info.pid) store.clearServerInfo();
  return true;
}
async function resolveRunningServer() {
  const existing = store.readServerInfo();
  if (!existing || !existing.port) return null;
  const health = await checkHealthPatient(existing.port);
  if (health) {
    if (!isRecordedServer(health, existing)) {
      const current2 = store.readServerInfo();
      if (current2 && current2.pid === existing.pid) store.clearServerInfo();
      return { action: "foreign", reason: "listener pid differs from server-info", existing };
    }
    if (PLUGIN_VERSION && (compareVersions(existing.version, PLUGIN_VERSION) ?? 0) < 0) {
      if (!await reapServer(existing, health)) {
        return { action: "blocked", reason: `stale version ${existing.version || "unknown"} could not stop`, existing };
      }
      return { action: "reap", reason: `stale version ${existing.version || "unknown"} (installed: ${PLUGIN_VERSION})`, existing };
    }
    return { action: "reuse", existing };
  }
  if (isPidAlive(existing.pid)) {
    if (!await reapServer(existing)) return { action: "blocked", reason: "unresponsive server could not stop", existing };
    return { action: "reap", reason: "unresponsive", existing };
  }
  const current = store.readServerInfo();
  if (current && current.pid === existing.pid) store.clearServerInfo();
  return { action: "reap", reason: "dead", existing };
}
async function ensureServer(requestedPort) {
  const running = await resolveRunningServer();
  if (running && running.action === "reuse") {
    return running.existing.url || `http://127.0.0.1:${running.existing.port}`;
  }
  if (running && running.action === "blocked") throw new Error(`the dashboard server is ${running.reason}`);
  const port = requestedPort || running && running.existing && running.existing.port || void 0;
  const args = [agentsync.ensureDispatchLauncher(), "serve"];
  if (port) args.push("--port", String(port));
  const child = spawn(process.execPath, args, { cwd: os.homedir(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await delay(150);
    const info = store.readServerInfo();
    if (info && info.port && isVersionAtLeast(info.version, PLUGIN_VERSION)) {
      const health = await checkHealth(info.port);
      if (health && isRecordedServer(health, info) && isVersionAtLeast(health.version, PLUGIN_VERSION)) return info.url || `http://127.0.0.1:${info.port}`;
    }
  }
  throw new Error("the dashboard server did not start in time");
}
function openBrowser(targetUrl) {
  try {
    let cmd;
    let args;
    if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", targetUrl];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [targetUrl];
    } else {
      cmd = "xdg-open";
      args = [targetUrl];
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (_) {
  }
}
async function cmdDashboard(opts) {
  try {
    await resolveProject(opts);
  } catch (_) {
  }
  const targetUrl = await ensureServer(opts.port);
  if (opts.open !== false) openBrowser(targetUrl);
  console.log(`sidequest dashboard: ${targetUrl}`);
  if (opts.open === false) console.log("(browser auto-open skipped; open the URL above)");
}
async function waitForHandoff(pid, timeoutMs = void 0) {
  if (!pid) return;
  const deadline = Date.now() + (timeoutMs || 10 * 1e3);
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`handoff server pid ${pid} did not exit in time`);
    await delay(100);
  }
}
async function cmdServe(opts) {
  if (opts.handoffPid) await waitForHandoff(Number(opts.handoffPid));
  const running = await resolveRunningServer();
  if (running && running.action === "reuse") {
    console.log(`sidequest dashboard already running at ${running.existing.url || "http://127.0.0.1:" + running.existing.port} (pid ${running.existing.pid}) — reusing it.`);
    console.log('Run "sidequest stop" first if you need to restart it in place.');
    return;
  }
  if (running && running.action === "reap") {
    console.log(`Recycled a ${running.reason} sidequest server (pid ${running.existing.pid}).`);
  }
  const server = require("../lib/server");
  const { url } = await server.start(opts.port || running && running.existing && running.existing.port);
  console.log(`sidequest dashboard running at ${url}`);
}
async function cmdStop() {
  const info = store.readServerInfo();
  if (!info || !info.pid) {
    console.log("No running sidequest server recorded.");
    return;
  }
  try {
    process.kill(info.pid);
    console.log(`Stopped sidequest server (pid ${info.pid}).`);
  } catch (e) {
    console.log(`Could not stop pid ${info.pid}: ${e.message}`);
  }
  store.clearServerInfo();
}
module.exports = { PLUGIN_VERSION, cmdDashboard, cmdServe, cmdStop };
