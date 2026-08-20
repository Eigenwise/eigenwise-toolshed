import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInstalledPluginsAtomically } from '../src/lib/installed-plugins.js';

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
const RENAME_RETRY_DELAYS_MS = [20, 60, 140, 300] as const;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameWithRetry(temporaryPath: string, targetPath: string): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, targetPath);
      return;
    } catch (error: unknown) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (delay == null || typeof code !== 'string' || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      Atomics.wait(waitBuffer, 0, 0, delay);
    }
  }
}

function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf8');
    renameWithRetry(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function stubSidequestInstall(): void {
  if (installed) return;
  installed = true;
  const claudeHome = process.env.SIDEQUEST_CLAUDE_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fake-claude-home-'));
  process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;

  const installPath = path.join(claudeHome, 'sidequest-test-install');
  fs.mkdirSync(installPath, { recursive: true });
  const manifestPath = path.join(installPath, '.mcp.json');
  writeFileAtomically(manifestPath, JSON.stringify({
    mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } },
  }));
  const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  writeFileAtomically(hooksPath, JSON.stringify({ hooks: {} }));

  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  let registry: { plugins?: Record<string, unknown> } = { plugins: {} };
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { plugins?: Record<string, unknown> };
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (!registry.plugins || typeof registry.plugins !== 'object') registry.plugins = {};
  const existing = Array.isArray(registry.plugins['sidequest@eigenwise-toolshed']) ? registry.plugins['sidequest@eigenwise-toolshed'] : [];
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
  registry.plugins['sidequest@eigenwise-toolshed'] = [
    ...existing.filter((entry: unknown) => !(entry && typeof entry === 'object' && 'installPath' in entry && entry.installPath === installPath)),
    { scope: 'user', installPath, version: manifest.version },
  ];

  writeInstalledPluginsAtomically(registryPath, JSON.stringify(registry));
}

stubSidequestInstall();
