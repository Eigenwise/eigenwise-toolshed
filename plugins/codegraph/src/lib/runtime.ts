import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeCacheDirectory } from './paths.js';
import type { RuntimeAcquirer, SemanticRuntime } from './runtime-contract.js';

const runtimeManifestFile = 'integrity.json';
const runtimePackageFile = 'package.json';
const runtimePackageLockFile = 'package-lock.json';
const runtimeModulesDirectory = 'node_modules';
const runtimeLockSuffix = '.lock';
const runtimeCurrentFile = 'current.json';
const runtimeGenerationsDirectory = 'generations';
const runtimeLockStaleMilliseconds = 5 * 60 * 1000;
const runtimeLockRetryMilliseconds = 25;
const inFlightAcquisitions = new Map<string, Promise<SemanticRuntime>>();

type JsonRecord = Record<string, unknown>;

interface PackageIntegrity {
  version: string;
  integrity: string;
}

interface RuntimeManifest {
  engine: {
    id: string;
    version: string;
    module: string;
    moduleFile: string;
    moduleIntegrity: string;
  };
  platformPackages: Record<string, string>;
  installedTreeIntegrity: Record<string, string>;
  packages: Record<string, PackageIntegrity>;
}

interface PackageLock {
  packages: Record<string, unknown>;
}

interface RuntimeCachePointer {
  generation: string;
}

export interface RuntimeInstaller {
  install(stageDirectory: string, runtimeManifestDirectory: string): Promise<void>;
}

interface RuntimeCacheLease {
  assertOwnership(): Promise<void>;
  release(): Promise<void>;
}

export interface TypeScriptRuntimeOptions {
  architecture?: string;
  environment?: NodeJS.ProcessEnv;
  installer?: RuntimeInstaller;
  platform?: NodeJS.Platform;
  runtimeManifestDirectory?: string;
  stateDirectory?: string;
  userHomeDirectory?: string;
}

export class SemanticRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticRuntimeError';
  }
}

export class UnsupportedRuntimePlatformError extends SemanticRuntimeError {
  constructor(platform: string, architecture: string) {
    super(`TypeScript semantic runtime does not support ${platform}-${architecture}`);
    this.name = 'UnsupportedRuntimePlatformError';
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackageIntegrity(value: unknown): value is PackageIntegrity {
  return isJsonRecord(value) && typeof value.version === 'string' && typeof value.integrity === 'string';
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isJsonRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isPackageIntegrityMap(value: unknown): value is Record<string, PackageIntegrity> {
  return isJsonRecord(value) && Object.values(value).every(isPackageIntegrity);
}

function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (!isJsonRecord(value) || !isJsonRecord(value.engine)) return false;
  const { engine, installedTreeIntegrity, packages, platformPackages } = value;
  return (
    typeof engine.id === 'string'
    && typeof engine.version === 'string'
    && typeof engine.module === 'string'
    && typeof engine.moduleFile === 'string'
    && typeof engine.moduleIntegrity === 'string'
    && isPackageIntegrityMap(packages)
    && isStringMap(installedTreeIntegrity)
    && isStringMap(platformPackages)
  );
}

function isPackageLock(value: unknown): value is PackageLock {
  return isJsonRecord(value) && isJsonRecord(value.packages);
}

function isRuntimeCachePointer(value: unknown): value is RuntimeCachePointer {
  return isJsonRecord(value) && typeof value.generation === 'string' && /^[a-f0-9-]+$/i.test(value.generation);
}

async function parseJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime metadata could not be read: ${filePath}: ${detail}`);
  }
}

async function readRuntimeManifest(runtimeManifestDirectory: string): Promise<RuntimeManifest> {
  const manifest = await parseJson(path.join(runtimeManifestDirectory, runtimeManifestFile));
  if (!isRuntimeManifest(manifest)) {
    throw new SemanticRuntimeError(`runtime integrity manifest is invalid: ${runtimeManifestDirectory}`);
  }
  return manifest;
}

async function readPackageLock(runtimeManifestDirectory: string): Promise<PackageLock> {
  const packageLock = await parseJson(path.join(runtimeManifestDirectory, runtimePackageLockFile));
  if (!isPackageLock(packageLock)) {
    throw new SemanticRuntimeError(`runtime package lock is invalid: ${runtimeManifestDirectory}`);
  }
  return packageLock;
}

function lockPackageKey(packageName: string): string {
  return `node_modules/${packageName}`;
}

function validateLockedPackage(packageLock: PackageLock, packageName: string, expected: PackageIntegrity): void {
  const locked = packageLock.packages[lockPackageKey(packageName)];
  if (!isPackageIntegrity(locked) || locked.version !== expected.version || locked.integrity !== expected.integrity) {
    throw new SemanticRuntimeError(`runtime lock integrity mismatch for ${packageName}`);
  }
}

function platformKey(platform: NodeJS.Platform, architecture: string): string {
  return `${platform}-${architecture}`;
}

export function runtimePlatformPackage(
  manifest: RuntimeManifest,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const packageName = manifest.platformPackages[platformKey(platform, architecture)];
  if (packageName === undefined) {
    throw new UnsupportedRuntimePlatformError(platform, architecture);
  }
  return packageName;
}

function validateManifestLock(manifest: RuntimeManifest, packageLock: PackageLock): void {
  for (const [packageName, expected] of Object.entries(manifest.packages)) {
    validateLockedPackage(packageLock, packageName, expected);
  }

  const enginePackage = manifest.packages[manifest.engine.id];
  if (enginePackage?.version !== manifest.engine.version) {
    throw new SemanticRuntimeError('runtime engine version does not match its integrity manifest');
  }

  for (const packageName of Object.values(manifest.platformPackages)) {
    if (manifest.packages[packageName] === undefined) {
      throw new SemanticRuntimeError(`runtime platform package is not pinned: ${packageName}`);
    }
  }
}

async function exists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

async function copyRuntimeManifest(runtimeManifestDirectory: string, stageDirectory: string): Promise<void> {
  await Promise.all([
    copyFile(path.join(runtimeManifestDirectory, runtimePackageFile), path.join(stageDirectory, runtimePackageFile)),
    copyFile(path.join(runtimeManifestDirectory, runtimePackageLockFile), path.join(stageDirectory, runtimePackageLockFile)),
  ]);
}

function waitForProcess(command: string, arguments_: readonly string[], workingDirectory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: workingDirectory,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new SemanticRuntimeError(`runtime install failed with exit code ${code ?? 'unknown'}`));
      }
    });
  });
}

export class NpmRuntimeInstaller implements RuntimeInstaller {
  async install(stageDirectory: string, runtimeManifestDirectory: string): Promise<void> {
    await copyRuntimeManifest(runtimeManifestDirectory, stageDirectory);
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await waitForProcess(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--fund=false'], stageDirectory);
  }
}

class LoadedTypeScriptRuntime implements SemanticRuntime {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly extractors = [];

  constructor(engineId: string, engineVersion: string) {
    this.engineId = engineId;
    this.engineVersion = engineVersion;
  }
}

function packageExportPath(packageMetadata: JsonRecord, moduleSpecifier: string, packageName: string): string {
  const modulePrefix = `${packageName}/`;
  if (!moduleSpecifier.startsWith(modulePrefix)) {
    throw new SemanticRuntimeError(`runtime module is outside its package: ${moduleSpecifier}`);
  }
  const exportKey = `./${moduleSpecifier.slice(modulePrefix.length)}`;
  const exports = packageMetadata.exports;
  if (!isJsonRecord(exports) || typeof exports[exportKey] !== 'string') {
    throw new SemanticRuntimeError(`runtime package does not export ${moduleSpecifier}`);
  }
  return exports[exportKey];
}

async function validateFileIntegrity(filePath: string, expectedIntegrity: string): Promise<void> {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expectedIntegrity)) {
    throw new SemanticRuntimeError(`runtime module integrity is invalid: ${filePath}`);
  }
  const content = await readFile(filePath);
  const actualIntegrity = `sha512-${createHash('sha512').update(content).digest('base64')}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new SemanticRuntimeError(`runtime module integrity mismatch: ${filePath}`);
  }
}

async function installedTreeIntegrity(directory: string): Promise<string> {
  const hash = createHash('sha512');
  async function hashDirectory(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await hashDirectory(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new SemanticRuntimeError(`runtime tree contains an unsupported entry: ${entryPath}`);
      }
      hash.update(path.relative(directory, entryPath).split(path.sep).join('/'));
      hash.update('\0');
      hash.update(await readFile(entryPath));
      hash.update('\0');
    }
  }
  await hashDirectory(directory);
  return `sha512-${hash.digest('base64')}`;
}

async function validateInstalledTree(runtimeDirectory: string, runtimeKey: string, manifest: RuntimeManifest): Promise<void> {
  const expectedIntegrity = manifest.installedTreeIntegrity[runtimeKey];
  if (expectedIntegrity === undefined) {
    throw new SemanticRuntimeError(`runtime tree integrity is not pinned: ${runtimeKey}`);
  }
  const actualIntegrity = await installedTreeIntegrity(path.join(runtimeDirectory, runtimeModulesDirectory));
  if (actualIntegrity !== expectedIntegrity) {
    throw new SemanticRuntimeError(`runtime tree integrity mismatch: ${runtimeKey}`);
  }
}

async function validatedModulePath(
  runtimeDirectory: string,
  manifest: RuntimeManifest,
  platformPackage: string,
): Promise<string> {
  let engineMetadata: JsonRecord | undefined;
  for (const packageName of [manifest.engine.id, platformPackage]) {
    const expected = manifest.packages[packageName];
    if (expected === undefined) {
      throw new SemanticRuntimeError(`runtime package is not pinned: ${packageName}`);
    }
    const packageMetadata = await parseJson(path.join(runtimeDirectory, runtimeModulesDirectory, packageName, runtimePackageFile));
    if (!isJsonRecord(packageMetadata) || packageMetadata.version !== expected.version) {
      throw new SemanticRuntimeError(`runtime package version mismatch for ${packageName}`);
    }
    if (packageName === manifest.engine.id) engineMetadata = packageMetadata;
  }

  if (engineMetadata === undefined) {
    throw new SemanticRuntimeError(`runtime engine package is missing: ${manifest.engine.id}`);
  }
  const exportedModuleFile = packageExportPath(engineMetadata, manifest.engine.module, manifest.engine.id);
  if (exportedModuleFile !== manifest.engine.moduleFile) {
    throw new SemanticRuntimeError(`runtime module export changed: ${manifest.engine.module}`);
  }

  const engineDirectory = path.resolve(runtimeDirectory, runtimeModulesDirectory, manifest.engine.id);
  const modulePath = path.resolve(engineDirectory, manifest.engine.moduleFile);
  if (!modulePath.startsWith(`${engineDirectory}${path.sep}`)) {
    throw new SemanticRuntimeError(`runtime module escapes its package: ${manifest.engine.moduleFile}`);
  }
  return modulePath;
}

async function validateInstalledRuntime(
  runtimeDirectory: string,
  runtimeKey: string,
  manifest: RuntimeManifest,
  platformPackage: string,
): Promise<void> {
  const modulePath = await validatedModulePath(runtimeDirectory, manifest, platformPackage);
  await validateInstalledTree(runtimeDirectory, runtimeKey, manifest);
  await validateFileIntegrity(modulePath, manifest.engine.moduleIntegrity);
}

async function createStageDirectory(cacheDirectory: string): Promise<string> {
  await mkdir(path.dirname(cacheDirectory), { recursive: true });
  return mkdtemp(path.join(path.dirname(cacheDirectory), `.${path.basename(cacheDirectory)}-staging-`));
}

async function currentRuntimeDirectory(cacheDirectory: string): Promise<string | undefined> {
  const pointerPath = path.join(cacheDirectory, runtimeCurrentFile);
  if (!(await exists(pointerPath))) return undefined;
  const pointer = await parseJson(pointerPath);
  if (!isRuntimeCachePointer(pointer)) {
    throw new SemanticRuntimeError(`runtime cache pointer is invalid: ${pointerPath}`);
  }
  return path.join(cacheDirectory, runtimeGenerationsDirectory, pointer.generation);
}

async function publishRuntimeStage(cacheDirectory: string, stageDirectory: string, lease: RuntimeCacheLease): Promise<void> {
  const generation = randomUUID();
  const generationsDirectory = path.join(cacheDirectory, runtimeGenerationsDirectory);
  const generationDirectory = path.join(generationsDirectory, generation);
  const temporaryPointerPath = path.join(cacheDirectory, `.${runtimeCurrentFile}-${generation}`);
  try {
    await lease.assertOwnership();
    await mkdir(generationsDirectory, { recursive: true });
    await rename(stageDirectory, generationDirectory);
    await lease.assertOwnership();
    await writeFile(temporaryPointerPath, JSON.stringify({ generation }), 'utf8');
    await rename(temporaryPointerPath, path.join(cacheDirectory, runtimeCurrentFile));
  } catch (error: unknown) {
    await rm(temporaryPointerPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime cache could not be published: ${detail}`);
  }
}

function waitForRuntimeLock(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, runtimeLockRetryMilliseconds));
}

function runtimeOwnerHeartbeatFile(lockDirectory: string, ownerToken: string): string {
  return path.join(lockDirectory, `owner-${ownerToken}`);
}

function runtimeOwnerReleaseFile(lockDirectory: string, ownerToken: string): string {
  return path.join(lockDirectory, `released-${ownerToken}`);
}

async function releaseRuntimeLock(lockDirectory: string, ownerToken: string): Promise<void> {
  await writeFile(runtimeOwnerReleaseFile(lockDirectory, ownerToken), 'released', { flag: 'wx' }).catch(() => undefined);
}

function runtimeLockLease(lockDirectory: string, ownerToken: string, heartbeat: NodeJS.Timeout): RuntimeCacheLease {
  return {
    async assertOwnership(): Promise<void> {
      try {
        if (await readFile(path.join(lockDirectory, 'owner'), 'utf8') === ownerToken) return;
      } catch {
        // The lock was moved or replaced while this holder was suspended.
      }
      throw new SemanticRuntimeError('runtime cache lock ownership was lost');
    },
    async release(): Promise<void> {
      clearInterval(heartbeat);
      await releaseRuntimeLock(lockDirectory, ownerToken);
    },
  };
}

async function discardUnverifiableRuntimeLock(lockDirectory: string): Promise<boolean> {
  const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await rename(lockDirectory, staleDirectory);
    await rm(staleDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isVerifiableRuntimeLockOwner(ownerToken: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(ownerToken);
}

async function breakStaleRuntimeLock(lockDirectory: string): Promise<boolean> {
  let ownerToken: string;
  try {
    ownerToken = await readFile(path.join(lockDirectory, 'owner'), 'utf8');
  } catch {
    return discardUnverifiableRuntimeLock(lockDirectory);
  }
  if (!isVerifiableRuntimeLockOwner(ownerToken)) return discardUnverifiableRuntimeLock(lockDirectory);

  const released = await exists(runtimeOwnerReleaseFile(lockDirectory, ownerToken));
  if (!released) {
    let lastHeartbeat: number;
    try {
      lastHeartbeat = (await stat(runtimeOwnerHeartbeatFile(lockDirectory, ownerToken))).mtimeMs;
    } catch {
      return false;
    }
    if (Date.now() - lastHeartbeat <= runtimeLockStaleMilliseconds) return false;
  }

  const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await rename(lockDirectory, staleDirectory);
    const movedOwnerToken = await readFile(path.join(staleDirectory, 'owner'), 'utf8');
    if (movedOwnerToken !== ownerToken) return false;
    await rm(staleDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireRuntimeLock(lockDirectory: string): Promise<RuntimeCacheLease> {
  while (true) {
    try {
      await mkdir(lockDirectory);
      const ownerFile = path.join(lockDirectory, 'owner');
      const ownerToken = randomUUID();
      await writeFile(ownerFile, ownerToken, 'utf8');
      const heartbeatFile = runtimeOwnerHeartbeatFile(lockDirectory, ownerToken);
      await writeFile(heartbeatFile, ownerToken, 'utf8');
      const heartbeat = setInterval(() => void utimes(heartbeatFile, new Date(), new Date()).catch(() => undefined), runtimeLockStaleMilliseconds / 3);
      heartbeat.unref();
      return runtimeLockLease(lockDirectory, ownerToken, heartbeat);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (await breakStaleRuntimeLock(lockDirectory)) continue;
      await waitForRuntimeLock();
    }
  }
}

async function withRuntimeCacheLock<T>(cacheDirectory: string, action: (lease: RuntimeCacheLease) => Promise<T>): Promise<T> {
  const lockDirectory = `${cacheDirectory}${runtimeLockSuffix}`;
  await mkdir(path.dirname(cacheDirectory), { recursive: true });
  const lease = await acquireRuntimeLock(lockDirectory);
  try {
    return await action(lease);
  } finally {
    await lease.release();
  }
}

export class TypeScriptRuntimeAcquirer implements RuntimeAcquirer {
  private readonly architecture: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly installer: RuntimeInstaller;
  private readonly platform: NodeJS.Platform;
  private readonly runtimeManifestDirectory: string;
  private readonly stateDirectory: string | undefined;
  private readonly userHomeDirectory: string | undefined;

  constructor(options: TypeScriptRuntimeOptions = {}) {
    this.architecture = options.architecture ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.installer = options.installer ?? new NpmRuntimeInstaller();
    this.platform = options.platform ?? process.platform;
    this.runtimeManifestDirectory = options.runtimeManifestDirectory ?? path.resolve(__dirname, '..', 'runtime');
    this.stateDirectory = options.stateDirectory;
    this.userHomeDirectory = options.userHomeDirectory;
  }

  acquire(): Promise<SemanticRuntime> {
    const cacheDirectory = this.cacheDirectory();
    const existing = inFlightAcquisitions.get(cacheDirectory);
    if (existing !== undefined) return existing;

    const acquisition = this.acquireRuntime(cacheDirectory).finally(() => {
      inFlightAcquisitions.delete(cacheDirectory);
    });
    inFlightAcquisitions.set(cacheDirectory, acquisition);
    return acquisition;
  }

  private cacheDirectory(): string {
    if (this.stateDirectory !== undefined) {
      return path.join(this.stateDirectory, 'runtime', '7.0.2', platformKey(this.platform, this.architecture));
    }
    return runtimeCacheDirectory('7.0.2', this.platform, this.architecture, this.environment, this.userHomeDirectory);
  }

  private async acquireRuntime(cacheDirectory: string): Promise<SemanticRuntime> {
    return withRuntimeCacheLock(cacheDirectory, (lease) => this.acquireLockedRuntime(cacheDirectory, lease));
  }

  private async acquireLockedRuntime(cacheDirectory: string, lease: RuntimeCacheLease): Promise<SemanticRuntime> {
    const manifest = await readRuntimeManifest(this.runtimeManifestDirectory);
    const packageLock = await readPackageLock(this.runtimeManifestDirectory);
    validateManifestLock(manifest, packageLock);
    const packageName = runtimePlatformPackage(manifest, this.platform, this.architecture);
    const runtimeKey = platformKey(this.platform, this.architecture);

    const cachedRuntimeDirectory = await currentRuntimeDirectory(cacheDirectory).catch(() => undefined);
    if (cachedRuntimeDirectory !== undefined) {
      try {
        await validateInstalledRuntime(cachedRuntimeDirectory, runtimeKey, manifest, packageName);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      } catch (error: unknown) {
        await this.replaceIncompleteCache(cacheDirectory, runtimeKey, manifest, packageName, lease, error);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      }
    }

    await this.installCache(cacheDirectory, runtimeKey, manifest, packageName, lease);
    return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
  }

  private async replaceIncompleteCache(
    cacheDirectory: string,
    runtimeKey: string,
    manifest: RuntimeManifest,
    packageName: string,
    lease: RuntimeCacheLease,
    previousError: unknown,
  ): Promise<void> {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await publishRuntimeStage(cacheDirectory, stageDirectory, lease);
    } catch (error: unknown) {
      await rm(stageDirectory, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache recovery failed after ${String(previousError)}: ${detail}`);
    }
  }

  private async installCache(
    cacheDirectory: string,
    runtimeKey: string,
    manifest: RuntimeManifest,
    packageName: string,
    lease: RuntimeCacheLease,
  ): Promise<void> {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await publishRuntimeStage(cacheDirectory, stageDirectory, lease);
    } catch (error: unknown) {
      await rm(stageDirectory, { recursive: true, force: true });
      const existingRuntimeDirectory = await currentRuntimeDirectory(cacheDirectory).catch(() => undefined);
      if (existingRuntimeDirectory !== undefined) {
        await validateInstalledRuntime(existingRuntimeDirectory, runtimeKey, manifest, packageName);
        return;
      }
      throw error;
    }
  }

  private async createValidatedStage(cacheDirectory: string, runtimeKey: string, manifest: RuntimeManifest, packageName: string): Promise<string> {
    const stageDirectory = await createStageDirectory(cacheDirectory);
    try {
      await this.installer.install(stageDirectory, this.runtimeManifestDirectory);
      await validateInstalledRuntime(stageDirectory, runtimeKey, manifest, packageName);
      return stageDirectory;
    } catch (error: unknown) {
      await rm(stageDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}
