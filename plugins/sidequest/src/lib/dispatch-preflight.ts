import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalAheadWarning {
  count: number;
  message: string;
}

export function localAheadOfUpstreamWarning(projectPath: string, branch: string): LocalAheadWarning | null {
  try {
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!upstream) return null;
    const count = Number(execFileSync('git', ['rev-list', '--count', `${upstream}..${branch}`], {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (!Number.isInteger(count) || count < 1) return null;
    const remote = execFileSync('git', ['config', '--get', `branch.${branch}.remote`], {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return remote ? {
      count,
      message: `Local ${branch} is ${count} commit${count === 1 ? '' : 's'} ahead of ${upstream}; isolated worktrees fork the local tracking ref. Push first: git push ${remote} ${branch}`,
    } : null;
  } catch (_) {
    return null;
  }
}

const PLUGIN_ID = 'sidequest@eigenwise-toolshed';
const REPAIR_COMMAND = 'claude plugin install sidequest@eigenwise-toolshed --scope project';
const FILE_READ_RETRY_DELAYS_MS = [20, 60, 140, 300] as const;
const RETRYABLE_FILE_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function isRetryableFileReadError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = error.code;
  return typeof code === 'string' && RETRYABLE_FILE_READ_CODES.has(code);
}

function readFileSyncWithRetry(filePath: string): Buffer;
function readFileSyncWithRetry(filePath: string, encoding: BufferEncoding): string;
function readFileSyncWithRetry(filePath: string, encoding?: BufferEncoding): Buffer | string {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
    } catch (error: unknown) {
      const delay = FILE_READ_RETRY_DELAYS_MS[attempt];
      if (delay == null || !isRetryableFileReadError(error)) throw error;
      Atomics.wait(waitBuffer, 0, 0, delay);
    }
  }
}

export interface InstallCheckOptions {
  claudeHome?: string;
}

export interface PythonIoEncodingCheckOptions {
  platform?: NodeJS.Platform;
}

export interface PythonIoEncodingCheckResult {
  written: boolean;
  settingsPath?: string;
}

export type InstallCheckReason = 'missing' | 'stale' | 'registry_unreadable' | 'runtime_unreadable';

export interface InstallCheckResult {
  ok: boolean;
  reason?: InstallCheckReason;
  registryPath: string;
  installPath?: string;
  identity?: string;
  detail?: string;
}

function claudeHomeDir(opts: InstallCheckOptions = {}): string {
  return opts.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function projectContainsPythonSource(projectPath: string): boolean {
  const pending = [projectPath];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) return true;
    }
  }
  return false;
}

export function ensurePythonIoEncoding(projectPath: string, opts: PythonIoEncodingCheckOptions = {}): PythonIoEncodingCheckResult {
  if ((opts.platform || process.platform) !== 'win32' || !projectContainsPythonSource(projectPath)) return { written: false };
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw new Error(`Dispatch refused: could not read project settings at ${settingsPath}: ${error.message}`);
  }
  const environment = settings.env;
  if (environment != null && (typeof environment !== 'object' || Array.isArray(environment))) {
    throw new Error(`Dispatch refused: project settings env must be an object at ${settingsPath}.`);
  }
  if (environment && Object.hasOwn(environment, 'PYTHONIOENCODING')) return { written: false, settingsPath };
  settings.env = { ...(environment || {}), PYTHONIOENCODING: 'utf-8' };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { written: true, settingsPath };
}

function normalizeDir(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// A registry entry proves the project has a *runnable, board-MCP-capable*
// install, not just a directory. The snapshot includes every configuration
// surface Claude Code resolves before an executor can act: the registry's
// selected plugin version, the MCP entry, and the hook set. File timestamps do
// not enter the snapshot, and JSON object ordering cannot change it.
type InstallRuntimeSnapshot =
  | { identity: string; advertisesBoardMcp: boolean }
  | { detail: string };

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  const record = jsonRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]));
}

function canonicalJsonFile(filePath: string): unknown {
  let content: string;
  try {
    content = readFileSyncWithRetry(filePath, 'utf8');
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${filePath}: ${detail}`);
  }
  try {
    return canonicalJson(JSON.parse(content));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse ${filePath}: ${detail}`);
  }
}

function installRuntimeSnapshot(installPath: unknown, version: unknown): InstallRuntimeSnapshot {
  if (typeof installPath !== 'string' || !installPath.trim()) return { detail: 'the registry entry has no installPath' };
  if (typeof version !== 'string' || !version.trim()) return { detail: `the registry entry for ${installPath} has no plugin version` };
  try {
    const mcpManifest = canonicalJsonFile(path.join(installPath, '.mcp.json'));
    const hooks = canonicalJsonFile(path.join(installPath, 'hooks', 'hooks.json'));
    const manifest = jsonRecord(mcpManifest);
    const mcpServers = jsonRecord(manifest?.mcpServers);
    const identity = createHash('sha256').update(JSON.stringify({
      schemaVersion: 2,
      plugin: { id: PLUGIN_ID, version: version.trim() },
      mcpManifest,
      hooks,
    })).digest('hex');
    return { identity, advertisesBoardMcp: Boolean(mcpServers && Object.keys(mcpServers).length) };
  } catch (error: unknown) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}

// Preflight for the one fact dispatch actually depends on: a fresh native
// Agent session started in `projectPath` will resolve `sidequest@eigenwise-toolshed`
// from Claude Code's installed-plugin registry and get its board MCP server.
// `.claude/settings.json`'s `enabledPlugins` is not proof of that — it can be
// true while the registry has no matching install (SQ-1017's repro).
export function checkSidequestInstall(projectPath: string, opts: InstallCheckOptions = {}): InstallCheckResult {
  const claudeHome = claudeHomeDir(opts);
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  let registry: any;
  try {
    registry = JSON.parse(readFileSyncWithRetry(registryPath, 'utf8'));
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing', registryPath };
    return { ok: false, reason: 'registry_unreadable', registryPath, detail: String((err && err.message) || err) };
  }
  const installs = registry?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(installs) || !installs.length) return { ok: false, reason: 'missing', registryPath };

  const target = normalizeDir(projectPath);
  // 'user' scope would apply to every project; Sidequest does not offer it
  // today, but nothing here should have to change if it starts to.
  const matching = installs.filter((install: any) => {
    if (!install) return false;
    if (install.scope === 'user') return true;
    if (!target) return false;
    return normalizeDir(install.projectPath) === target;
  });
  if (!matching.length) return { ok: false, reason: 'missing', registryPath };

  for (const install of matching) {
    const snapshot = installRuntimeSnapshot(install.installPath, install.version);
    if ('detail' in snapshot) {
      return {
        ok: false,
        reason: 'runtime_unreadable',
        registryPath,
        ...(typeof install.installPath === 'string' ? { installPath: install.installPath } : {}),
        detail: snapshot.detail,
      };
    }
    if (snapshot.advertisesBoardMcp) {
      return { ok: true, registryPath, installPath: install.installPath, identity: snapshot.identity };
    }
  }
  return { ok: false, reason: 'stale', registryPath, detail: 'the .mcp.json snapshot declares no MCP server' };
}

function repairGuidance(): string {
  return `Run \`${REPAIR_COMMAND}\` from / for the target project, then start a new session or run \`/reload-plugins\` before dispatching again.`;
}

export function installRefusalMessage(check: InstallCheckResult, projectPath: string): string {
  if (check.reason === 'registry_unreadable') {
    return `Dispatch refused: could not read Claude Code's plugin registry at ${check.registryPath} (${check.detail}). Fix or remove the corrupt registry, confirm sidequest@eigenwise-toolshed is installed for ${projectPath}, then dispatch again.`;
  }
  if (check.reason === 'runtime_unreadable') {
    return `Dispatch refused: could not compute the lifecycle-compatible Sidequest install identity for ${check.installPath || projectPath} (${check.detail}). Prepared dispatch compatibility requires the registry plugin version, .mcp.json, and hooks/hooks.json. ${repairGuidance()}`;
  }
  if (check.reason === 'stale') {
    return `Dispatch refused: the sidequest@eigenwise-toolshed install registered for ${projectPath} (checked ${check.registryPath}) does not declare a board MCP server, so prepared dispatch compatibility cannot be proven. ${repairGuidance()}`;
  }
  return `Dispatch refused: sidequest@eigenwise-toolshed has no install with a lifecycle-compatible runtime registered for ${projectPath} in ${check.registryPath}. A \`.claude/settings.json\` enabledPlugins entry is not proof of an install. ${repairGuidance()}`;
}

// Single preflight owner for every path that hands a fresh session a claim-first
// spawn spec: CLI/MCP dispatch (via prepareDispatch) and CLI/MCP native-agent
// both call this before doing anything else, so neither can drift independently.
export function assertSidequestInstall(projectPath: string, opts: InstallCheckOptions = {}): InstallCheckResult {
  const check = checkSidequestInstall(projectPath, opts);
  if (!check.ok) throw new Error(installRefusalMessage(check, projectPath));
  return check;
}

// The install check above proves a FUTURE fresh session in the target
// project would get the board MCP. It says nothing about whether THIS
// invocation can prove the CURRENT session already has it connected — and
// the second SQ-1016 dispatch proved those are different facts: a project
// install registered mid-session does not retroactively connect the MCP
// server into a conversation whose roster was already loaded (or empty).
//
// An MCP `dispatch`/`native_agent` tool call is itself proof: reaching this
// handler at all means the board MCP is loaded in this session. A CLI
// invocation cannot offer that proof — it runs in a separate process that
// may or may not share the calling conversation's connected MCP roster, even
// when it inherits the same CLAUDE_CODE_SESSION_ID. So CLI transport refuses
// unless the caller explicitly acknowledges the gap via the escape hatch.
export type DispatchTransport = 'mcp' | 'cli';

export interface TransportCheckOptions {
  allowUnverifiedTransport?: boolean;
}

export function transportRefusalMessage(): string {
  return 'Dispatch refused: the CLI cannot prove this Claude Code session has the Sidequest board MCP connected — '
    + 'a fresh native Agent could still receive zero board tools even though the target project\'s install looks fine. '
    + 'Run `/reload-plugins` in this session, then dispatch again through the board MCP `dispatch`/`native_agent` tool '
    + '(reaching that tool is itself proof the MCP is connected). If you are intentionally running the CLI outside '
    + 'Claude Code for diagnostics, pass --unverified-transport to proceed anyway; it does NOT prove any session will '
    + 'have the board MCP available.';
}

export function assertDispatchTransport(transport?: DispatchTransport | null, opts: TransportCheckOptions = {}): void {
  if (transport !== 'cli') return; // undefined/'mcp' callers already prove or don't need to prove connectivity
  if (opts.allowUnverifiedTransport) return;
  throw new Error(transportRefusalMessage());
}
