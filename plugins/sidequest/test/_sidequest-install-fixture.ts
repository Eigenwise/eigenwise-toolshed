import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SQ-1017: dispatch and native-agent now refuse before spawning unless the
// target project has a registered, board-MCP-capable Sidequest install (see
// ../src/lib/dispatch-preflight.ts). Most tests in this suite dispatch
// throwaway fixture projects that were never installed anywhere, so without
// this stub every one of them would start failing that preflight against
// whatever installed_plugins.json happens to exist on the machine running
// the tests. Registering a single 'user'-scope install (which the preflight
// treats as applying to every project, forward-compatible with a
// user-scoped install Sidequest doesn't offer yet) keeps these tests
// hermetic without having to enumerate every fixture project path a test
// file touches.
//
// A test that specifically exercises the exact-project-match behavior of
// the preflight (claim-effort-guard.test.ts) sets its own isolated
// SIDEQUEST_CLAUDE_HOME instead of calling this.
let installed = false;

export function stubSidequestInstall(): void {
  if (installed) return;
  installed = true;
  const claudeHome = process.env.SIDEQUEST_CLAUDE_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fake-claude-home-'));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;

  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fake-sidequest-install-'));
  fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({
    mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } },
  }));

  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  let registry: any = { plugins: {} };
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch (_) {}
  if (!registry.plugins || typeof registry.plugins !== 'object') registry.plugins = {};
  const existing = Array.isArray(registry.plugins['sidequest@eigenwise-toolshed']) ? registry.plugins['sidequest@eigenwise-toolshed'] : [];
  const currentVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  existing.push({ scope: 'user', installPath, version: currentVersion });
  registry.plugins['sidequest@eigenwise-toolshed'] = existing;

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry));
}

stubSidequestInstall();
