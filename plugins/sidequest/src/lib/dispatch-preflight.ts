import { execFileSync } from 'node:child_process';
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

export type InstallCheckReason = 'missing' | 'stale' | 'registry_unreadable';

export interface InstallCheckResult {
  ok: boolean;
  reason?: InstallCheckReason;
  registryPath: string;
  installPath?: string;
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
// install, not just a directory. A missing installPath (uninstalled since
// registration) or an install whose .mcp.json no longer declares the board
// server both count as unusable — the caller only cares whether a fresh
// session in this project would actually get the board MCP tools.
function installAdvertisesBoardMcp(installPath: unknown): boolean {
  if (typeof installPath !== 'string' || !installPath) return false;
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(installPath, '.mcp.json'), 'utf8'));
  } catch (_) {
    return false;
  }
  return Boolean(manifest && manifest.mcpServers && typeof manifest.mcpServers === 'object' && Object.keys(manifest.mcpServers).length > 0);
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
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
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
    if (installAdvertisesBoardMcp(install.installPath)) {
      return { ok: true, registryPath, installPath: install.installPath };
    }
  }
  return { ok: false, reason: 'stale', registryPath };
}

function repairGuidance(): string {
  return `Run \`${REPAIR_COMMAND}\` from / for the target project, then start a new session or run \`/reload-plugins\` before dispatching again.`;
}

export function installRefusalMessage(check: InstallCheckResult, projectPath: string): string {
  if (check.reason === 'registry_unreadable') {
    return `Dispatch refused: could not read Claude Code's plugin registry at ${check.registryPath} (${check.detail}). Fix or remove the corrupt registry, confirm sidequest@eigenwise-toolshed is installed for ${projectPath}, then dispatch again.`;
  }
  if (check.reason === 'stale') {
    return `Dispatch refused: the sidequest@eigenwise-toolshed install registered for ${projectPath} (checked ${check.registryPath}) is missing or no longer declares the board MCP server. ${repairGuidance()}`;
  }
  return `Dispatch refused: sidequest@eigenwise-toolshed has no install registered for ${projectPath} in ${check.registryPath}. A \`.claude/settings.json\` enabledPlugins entry is not proof of an install. ${repairGuidance()}`;
}

// Single preflight owner for every path that hands a fresh session a claim-first
// spawn spec: CLI/MCP dispatch (via prepareDispatch) and CLI/MCP native-agent
// both call this before doing anything else, so neither can drift independently.
export function assertSidequestInstall(projectPath: string, opts: InstallCheckOptions = {}): void {
  const check = checkSidequestInstall(projectPath, opts);
  if (!check.ok) throw new Error(installRefusalMessage(check, projectPath));
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
