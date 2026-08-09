import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

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

export function normalizeProjectRoot(projectRoot: string): string {
  return normalizedPath(path.resolve(projectRoot));
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
): string {
  return path.join(
    codegraphStateRoot(environment, userHomeDirectory),
    'runtime',
    engineVersion,
    `${platform}-${architecture}`,
  );
}
