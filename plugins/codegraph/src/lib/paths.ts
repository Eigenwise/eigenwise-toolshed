import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Counting `..` hops to reach the plugin root gives a different answer from src/
// than from the compiled lib/, because the build drops the src segment. Tests run
// from src and shipped code runs from lib, so a hop count that satisfies one is
// silently wrong in the other. Anchor on the package manifest instead.
export function pluginRootDirectory(fromDirectory: string): string {
  let current = path.resolve(fromDirectory);
  for (;;) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`codegraph plugin root not found above ${fromDirectory}`);
    current = parent;
  }
}

const projectPathSeparator = '/';

function normalizedPath(pathValue: string): string {
  return pathValue.replaceAll('\\', projectPathSeparator);
}

function isAbsoluteProjectPath(pathValue: string): boolean {
  return path.posix.isAbsolute(pathValue) || /^[A-Za-z]:\//.test(pathValue);
}

export function normalizeProjectRelativePath(pathValue: string): string {
  const normalized = normalizedPath(pathValue);
  if (isAbsoluteProjectPath(normalized)) {
    throw new Error(`project path must be relative: ${pathValue}`);
  }

  const relativePath = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (relativePath === '' || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`project path escapes the project root: ${pathValue}`);
  }
  return relativePath;
}

/**
 * Resolves junctions, symlinks, and Windows 8.3 short names. A caller can reach one directory
 * through several names — GitHub's Windows runner hands tests `C:\Users\RUNNER~1\...` while
 * TypeScript reports the same files under `C:\Users\runneradmin\...` — and only paths reduced to
 * this one form can be compared or subtracted from each other.
 */
export function canonicalFilesystemPath(pathValue: string): string {
  const resolvedPath = path.resolve(pathValue);
  try {
    return realpathSync.native(resolvedPath);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return resolvedPath;
    throw error;
  }
}

export function normalizeProjectRoot(projectRoot: string): string {
  const canonicalRoot = normalizedPath(canonicalFilesystemPath(projectRoot));
  return process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
}

export function projectIdentity(projectRoot: string): string {
  return createHash('sha256').update(normalizeProjectRoot(projectRoot)).digest('hex');
}

export function codegraphStateRoot(
  environment: NodeJS.ProcessEnv = process.env,
  userHomeDirectory: string = homedir(),
): string {
  const override = environment.CODEGRAPH_STATE_DIR;
  return path.resolve(override ?? path.join(userHomeDirectory, '.claude', 'codegraph'));
}

export function projectStateDirectory(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHomeDirectory: string = homedir(),
): string {
  return path.join(codegraphStateRoot(environment, userHomeDirectory), 'projects', projectIdentity(projectRoot));
}

export function runtimeCacheDirectory(
  engineVersion: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  environment: NodeJS.ProcessEnv = process.env,
  userHomeDirectory: string = homedir(),
  cacheIdentity: string = `${platform}-${architecture}`,
): string {
  return path.join(
    codegraphStateRoot(environment, userHomeDirectory),
    'runtime',
    engineVersion,
    cacheIdentity,
  );
}
