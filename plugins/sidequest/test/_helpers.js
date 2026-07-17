'use strict';
// Shared harnesses for the sidequest test files, so each new file stops
// hand-rolling its own spawn/call helpers (brief.test.js was about to be the
// fourth copy of runCli/cliJson and the second of callTool). Named with a
// leading underscore so `node --test` globbing never treats it as a suite.
const assert = require('node:assert');
const { spawnSync } = require('child_process');

// A CLI runner bound to a bin path and env overrides.
function makeCliRunner(bin, envOverrides, options) {
  function runCli(args) {
    const env = Object.assign({}, process.env, envOverrides || {});
    const res = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, cwd: (options && options.cwd) || process.cwd() });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  }
  function cliJson(args) {
    const res = runCli(args);
    assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\n${res.stderr}${res.stdout}`);
    return JSON.parse(res.stdout);
  }
  return { runCli, cliJson };
}

// An MCP tool caller bound to an already-required lib/mcp.js module. The env
// vars (SIDEQUEST_HOME, CLAUDE_PROJECT_DIR) must be set BEFORE that require —
// which is why this takes the module rather than requiring it itself.
function makeMcpCaller(mcp) {
  let idc = 0;
  function callToolRaw(name, args) {
    const resp = mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
    return resp && resp.result;
  }
  function callTool(name, args) {
    const result = callToolRaw(name, args);
    assert.ok(result, `tool ${name} returned a result`);
    assert.ok(!result.isError, `tool ${name} errored: ${result.content && result.content[0] && result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  }
  return { callTool, callToolRaw };
}

module.exports = { makeCliRunner, makeMcpCaller };
