import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SIDEQUEST_PLUGIN_ID = 'sidequest@eigenwise-toolshed';

interface PluginInstall {
  projectPath?: unknown;
  scope?: unknown;
  version?: unknown;
}

interface PluginRegistry {
  plugins?: Record<string, unknown>;
}

interface ParsedSemver {
  core: number[];
  prerelease: string[];
}

export interface FreshnessOptions {
  claudeHome?: string;
  pluginRoot?: string;
  stateDirectory?: string;
}

function claudeHome(options: FreshnessOptions = {}): string {
  return options.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function normalizedPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseSemver(value: unknown): ParsedSemver | null {
  const match = String(value || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

export function compareSemver(left: unknown, right: unknown): -1 | 0 | 1 | null {
  const first = parseSemver(left);
  const second = parseSemver(right);
  if (!first || !second) return null;
  for (let index = 0; index < first.core.length; index += 1) {
    if (first.core[index] !== second.core[index]) return first.core[index]! < second.core[index]! ? -1 : 1;
  }
  if (!first.prerelease.length || !second.prerelease.length) {
    return first.prerelease.length === second.prerelease.length ? 0 : first.prerelease.length ? -1 : 1;
  }
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (first.prerelease[index] === undefined) return -1;
    if (second.prerelease[index] === undefined) return 1;
    if (first.prerelease[index] === second.prerelease[index]) continue;
    const firstNumber = /^\d+$/.test(first.prerelease[index]!);
    const secondNumber = /^\d+$/.test(second.prerelease[index]!);
    if (firstNumber && secondNumber) return Number(first.prerelease[index]) < Number(second.prerelease[index]) ? -1 : 1;
    if (firstNumber !== secondNumber) return firstNumber ? -1 : 1;
    return first.prerelease[index]! < second.prerelease[index]! ? -1 : 1;
  }
  return 0;
}

function registryInstalls(projectPath: string, options: FreshnessOptions = {}): PluginInstall[] {
  let registry: PluginRegistry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(claudeHome(options), 'plugins', 'installed_plugins.json'), 'utf8')) as PluginRegistry;
  } catch (_) {
    return [];
  }
  const installs = registry.plugins?.[SIDEQUEST_PLUGIN_ID];
  if (!Array.isArray(installs)) return [];
  const currentPath = normalizedPath(projectPath);
  if (!currentPath) return [];
  return installs.filter((install): install is PluginInstall => {
    if (!install || typeof install !== 'object') return false;
    if (install.scope === 'user') return true;
    const installedProject = normalizedPath(install.projectPath);
    return installedProject !== null && pathsOverlap(currentPath, installedProject);
  });
}

export function loadedPluginVersion(pluginRoot: string | undefined = process.env.CLAUDE_PLUGIN_ROOT): string | null {
  if (!pluginRoot) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch (_) {
    return null;
  }
}

export function installedSidequestVersion(projectPath: string, options: FreshnessOptions = {}): string | null {
  const installs = registryInstalls(projectPath, options);
  const projectInstall = installs.find((install) => install.scope === 'project' || install.scope === 'local');
  const selected = projectInstall || installs.find((install) => install.scope === 'user');
  return typeof selected?.version === 'string' ? selected.version : null;
}

export function sidequestReloadWarning(projectPath: string, options: FreshnessOptions = {}): string {
  const loadedVersion = loadedPluginVersion(options.pluginRoot);
  const installedVersion = installedSidequestVersion(projectPath, options);
  if (!loadedVersion || !installedVersion || compareSemver(loadedVersion, installedVersion) !== -1) return '';
  return `Sidequest: loaded ${loadedVersion}, installed ${installedVersion}. Run /reload-plugins or restart Claude Code before dispatching work.`;
}

function stateDirectory(options: FreshnessOptions = {}): string {
  return options.stateDirectory || path.join(os.tmpdir(), 'eigenwise-toolshed', 'freshness-warnings', 'loaded-plugin-versions');
}

function sessionId(input: Record<string, unknown>): string {
  const value = input.session_id ?? input.sessionId;
  return value == null ? '' : String(value);
}

export function loadedVersionStateFile(input: Record<string, unknown>, pluginId = SIDEQUEST_PLUGIN_ID, options: FreshnessOptions = {}): string | null {
  const id = sessionId(input);
  if (!id) return null;
  const digest = crypto.createHash('sha256').update(`${id}\0${pluginId}`).digest('hex');
  return path.join(stateDirectory(options), `${digest}.json`);
}

export function reportLoadedSidequestVersion(input: Record<string, unknown>, options: FreshnessOptions = {}): string | null {
  const version = loadedPluginVersion(options.pluginRoot);
  const stateFile = loadedVersionStateFile(input, SIDEQUEST_PLUGIN_ID, options);
  if (!version || !stateFile) return version;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ pluginId: SIDEQUEST_PLUGIN_ID, version }));
  } catch (_) {
  }
  return version;
}
