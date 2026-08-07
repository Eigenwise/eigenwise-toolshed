'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(fileSystem, file) {
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function pluginIdParts(id) {
  const index = String(id || '').lastIndexOf('@');
  return index > 0 ? { name: id.slice(0, index), marketplace: id.slice(index + 1) } : null;
}

function parseSemver(value) {
  const match = String(value || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]);
    const bNumber = /^\d+$/.test(b.prerelease[index]);
    if (aNumber && bNumber) return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function pluginInstances(registry) {
  const instances = [];
  for (const [id, installs] of Object.entries(registry?.plugins || {})) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) instances.push({ id, ...install });
  }
  return instances;
}

function canonicalPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return null;
  const api = platform === 'win32' ? path.win32 : path;
  const resolved = api.resolve(value);
  const missingSegments = [];
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = api.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(api.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    const canonical = fs.realpathSync.native(existingAncestor);
    const completed = api.join(canonical, ...missingSegments);
    return platform === 'win32' ? completed.toLowerCase() : completed;
  } catch {
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function normalizePath(value, platform = process.platform) {
  const canonical = canonicalPath(value, platform);
  return canonical?.replace(/\\/g, '/').replace(/\/+$/, '') ?? null;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function activeInstances(registry, cwd, marketplace, platform = process.platform) {
  const sessionPath = normalizePath(cwd, platform);
  return pluginInstances(registry).flatMap((instance) => {
    const parts = pluginIdParts(instance.id);
    if (!parts || parts.marketplace !== marketplace || !['user', 'project', 'local'].includes(instance.scope)) return [];
    if (instance.scope === 'user') return [{ ...instance, name: parts.name }];
    const projectPath = normalizePath(instance.projectPath, platform);
    return sessionPath && projectPath && pathsOverlap(sessionPath, projectPath) ? [{ ...instance, name: parts.name }] : [];
  });
}

module.exports = {
  activeInstances,
  canonicalPath,
  compareSemver,
  parseSemver,
  pluginIdParts,
  pluginInstances,
  readJson,
};
