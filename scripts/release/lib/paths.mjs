import { lstatSync } from 'node:fs';
import path from 'node:path';

// Manifest data decides which files the engine rewrites, so every path derived from it is
// untrusted input. A `source` of "../../victim" would otherwise write outside the repository.

const PLUGIN_SOURCE = /^plugins\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class UnsafePathError extends Error {}

export function normalizeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UnsafePathError(`${label} must be a non-empty relative path`);
  }
  const cleaned = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || path.isAbsolute(cleaned)) {
    throw new UnsafePathError(`${label} "${value}" must be relative to the repository root`);
  }
  const segments = cleaned.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new UnsafePathError(`${label} must be a non-empty relative path`);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('\0')) {
      throw new UnsafePathError(`${label} "${value}" escapes the repository through "${segment}"`);
    }
  }
  return segments.join('/');
}

/** A marketplace entry may only point at `plugins/<name>`, and nowhere else. */
export function pluginSourceDir(source, name) {
  const normalized = normalizeRelative(source ?? `plugins/${name}`, `source for plugin "${name}"`);
  if (!PLUGIN_SOURCE.test(normalized)) {
    throw new UnsafePathError(
      `source for plugin "${name}" must be "plugins/<name>", got "${source}"; the release engine only writes inside plugins/`,
    );
  }
  return normalized;
}

/**
 * Resolves a repo-relative path to an absolute one, refusing anything that leaves the repository
 * or reaches it through a symlink. A symlinked plugin directory would make an in-repo write land
 * anywhere on the machine.
 */
export function resolveInRepo(repoRoot, relative, label = relative) {
  const normalized = normalizeRelative(relative, label);
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, normalized);
  const inside = absolute === root || absolute.startsWith(root + path.sep);
  if (!inside) throw new UnsafePathError(`${label} "${relative}" resolves outside the repository`);

  let walked = root;
  for (const segment of normalized.split('/')) {
    walked = path.join(walked, segment);
    let stats = null;
    try {
      stats = lstatSync(walked);
    } catch {
      break; // Not created yet; the parents that do exist have already been checked.
    }
    if (stats.isSymbolicLink()) {
      throw new UnsafePathError(`${label} "${relative}" passes through the symlink "${path.relative(root, walked).replaceAll('\\', '/')}"`);
    }
  }

  return absolute;
}
