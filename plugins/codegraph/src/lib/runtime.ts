import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
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
const runtimeReclaimProbeTimeoutMilliseconds = 250;
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

function runtimeOwnerGenerationFile(lockDirectory: string, ownerToken: string): string {
  return path.join(lockDirectory, `generation-${ownerToken}`);
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
        const [currentOwnerToken, generationToken] = await Promise.all([
          readFile(path.join(lockDirectory, 'owner'), 'utf8'),
          readFile(runtimeOwnerGenerationFile(lockDirectory, ownerToken), 'utf8'),
        ]);
        if (currentOwnerToken === ownerToken && generationToken === ownerToken) return;
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

function isVerifiableRuntimeLockOwner(ownerToken: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(ownerToken);
}

interface RuntimeReclaimIdentity {
  port: number;
  token: string;
}

interface RuntimeReclaimGuard extends RuntimeReclaimIdentity {
  server: Server;
}

interface LegacyRuntimeReclaim extends RuntimeReclaimIdentity {
  generationToken: string;
}

type RuntimeReclaimIdentityStatus = 'live' | 'dead' | 'unknown';
type RuntimeReclaimRecovery = 'none' | 'active' | 'unknown' | 'reclaimed';

const runtimeReclaimMarkerPattern = /^reclaim-([a-f0-9-]{36})\.(\d+)\.([a-f0-9-]{36})$/i;

async function openRuntimeReclaimGuard(): Promise<RuntimeReclaimGuard> {
  const token = randomUUID();
  const server = createServer((socket) => socket.end(token));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new SemanticRuntimeError('runtime reclaim guard did not bind a TCP port');
  }
  server.unref();
  return { port: address.port, server, token };
}

async function closeRuntimeReclaimGuard(guard: RuntimeReclaimGuard): Promise<void> {
  await new Promise<void>((resolve) => guard.server.close(() => resolve()));
}

function runtimeReclaimMarker(lockDirectory: string, generationToken: string, identity: RuntimeReclaimIdentity): string {
  return path.join(lockDirectory, `reclaim-${generationToken}.${identity.port}.${identity.token}`);
}

function parseRuntimeReclaimMarker(fileName: string): { generationToken: string; identity: RuntimeReclaimIdentity } | undefined {
  const match = runtimeReclaimMarkerPattern.exec(fileName);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  return { generationToken: match[1]!, identity: { port, token: match[3]! } };
}

async function runtimeReclaimerIdentityStatus(identity: RuntimeReclaimIdentity): Promise<RuntimeReclaimIdentityStatus> {
  return new Promise((resolve) => {
    let response = '';
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port: identity.port });
    const timeout = setTimeout(() => finish('unknown'), runtimeReclaimProbeTimeoutMilliseconds);
    const finish = (status: RuntimeReclaimIdentityStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(status);
    };
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      response += data;
      if (response.length > identity.token.length || !identity.token.startsWith(response)) {
        finish('unknown');
      }
    });
    socket.once('end', () => finish(response === identity.token ? 'live' : 'unknown'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'dead' : 'unknown');
    });
  });
}

async function moveClaimedRuntimeLock(
  lockDirectory: string,
  claimMarker: string,
  guard: RuntimeReclaimGuard,
): Promise<boolean> {
  const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await access(claimMarker);
    await rename(lockDirectory, staleDirectory);
    await rm(staleDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    await closeRuntimeReclaimGuard(guard);
  }
}

async function continueRuntimeReclaim(
  lockDirectory: string,
  observedMarker: string,
  generationToken: string,
): Promise<boolean> {
  const guard = await openRuntimeReclaimGuard();
  const claimMarker = runtimeReclaimMarker(lockDirectory, generationToken, guard);
  try {
    await rename(observedMarker, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}

export async function recoverRuntimeReclaim(lockDirectory: string): Promise<RuntimeReclaimRecovery> {
  let entries: string[];
  try {
    entries = await readdir(lockDirectory);
  } catch {
    return 'none';
  }

  for (const entry of entries) {
    const reclaim = parseRuntimeReclaimMarker(entry);
    if (reclaim === undefined) continue;
    const identityStatus = await runtimeReclaimerIdentityStatus(reclaim.identity);
    if (identityStatus === 'live') return 'active';
    if (identityStatus === 'unknown') return 'unknown';
    return await continueRuntimeReclaim(
      lockDirectory,
      path.join(lockDirectory, entry),
      reclaim.generationToken,
    ) ? 'reclaimed' : 'active';
  }
  return 'none';
}

function parseLegacyRuntimeReclaim(value: string): LegacyRuntimeReclaim | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (!('generationToken' in parsed) || !('port' in parsed) || !('token' in parsed)) return undefined;
    if (typeof parsed.generationToken !== 'string' || !isVerifiableRuntimeLockOwner(parsed.generationToken)) return undefined;
    if (typeof parsed.token !== 'string' || !isVerifiableRuntimeLockOwner(parsed.token)) return undefined;
    if (typeof parsed.port !== 'number' || !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535) return undefined;
    return { generationToken: parsed.generationToken, port: parsed.port, token: parsed.token };
  } catch {
    return undefined;
  }
}

export async function recoverLegacyRuntimeReclaim(lockDirectory: string): Promise<RuntimeReclaimRecovery> {
  const claimFile = path.join(lockDirectory, 'legacy-reclaim');
  let reclaim: LegacyRuntimeReclaim;
  try {
    const parsed = parseLegacyRuntimeReclaim(await readFile(claimFile, 'utf8'));
    if (parsed === undefined) {
      return await continueRuntimeReclaim(lockDirectory, claimFile, randomUUID()) ? 'reclaimed' : 'active';
    }
    reclaim = parsed;
  } catch {
    return 'none';
  }
  const identityStatus = await runtimeReclaimerIdentityStatus(reclaim);
  if (identityStatus === 'live') return 'active';
  if (identityStatus === 'unknown') return 'unknown';
  return await continueRuntimeReclaim(lockDirectory, claimFile, reclaim.generationToken) ? 'reclaimed' : 'active';
}

async function claimLegacyRuntimeLock(lockDirectory: string, observedOwnerToken?: string): Promise<boolean> {
  const guard = await openRuntimeReclaimGuard();
  const generationToken = randomUUID();
  const preparedClaimFile = path.join(lockDirectory, `.legacy-reclaim-${generationToken}`);
  const claimFile = path.join(lockDirectory, 'legacy-reclaim');
  const serializedClaim = JSON.stringify({ generationToken, port: guard.port, token: guard.token });
  try {
    await writeFile(preparedClaimFile, serializedClaim, { flag: 'wx' });
    await link(preparedClaimFile, claimFile);
    await rm(preparedClaimFile, { force: true });
  } catch {
    await rm(preparedClaimFile, { force: true });
    await closeRuntimeReclaimGuard(guard);
    return false;
  }

  try {
    const entries = await readdir(lockDirectory);
    if (entries.some((entry) => entry.startsWith('generation-'))) {
      await rm(claimFile, { force: true });
      await closeRuntimeReclaimGuard(guard);
      return false;
    }
    if (observedOwnerToken !== undefined) {
      const currentOwnerToken = await readFile(path.join(lockDirectory, 'owner'), 'utf8');
      if (currentOwnerToken !== observedOwnerToken) {
        await rm(claimFile, { force: true });
        await closeRuntimeReclaimGuard(guard);
        return false;
      }
    }
  } catch {
    await rm(claimFile, { force: true });
    await closeRuntimeReclaimGuard(guard);
    return false;
  }

  const claimMarker = runtimeReclaimMarker(lockDirectory, generationToken, guard);
  try {
    await rename(claimFile, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}

export async function reclaimObservedRuntimeLock(lockDirectory: string, ownerToken: string): Promise<boolean> {
  try {
    if (await readFile(path.join(lockDirectory, 'owner'), 'utf8') !== ownerToken) return false;
  } catch {
    return false;
  }

  if (!(await exists(runtimeOwnerReleaseFile(lockDirectory, ownerToken)))) {
    try {
      const lastHeartbeat = (await stat(runtimeOwnerHeartbeatFile(lockDirectory, ownerToken))).mtimeMs;
      if (Date.now() - lastHeartbeat <= runtimeLockStaleMilliseconds) return false;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return false;
    }
  }

  const guard = await openRuntimeReclaimGuard();
  const generationFile = runtimeOwnerGenerationFile(lockDirectory, ownerToken);
  const claimMarker = runtimeReclaimMarker(lockDirectory, ownerToken, guard);
  try {
    await rename(generationFile, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}

async function breakStaleRuntimeLock(lockDirectory: string): Promise<boolean> {
  const generatedReclaim = await recoverRuntimeReclaim(lockDirectory);
  if (generatedReclaim === 'unknown') {
    throw new SemanticRuntimeError(
      `runtime cache lock reclaim identity did not respond at ${lockDirectory}; the claim was preserved, retry after confirming its claimant exited`,
    );
  }
  if (generatedReclaim !== 'none') return generatedReclaim === 'reclaimed';
  const legacyReclaim = await recoverLegacyRuntimeReclaim(lockDirectory);
  if (legacyReclaim === 'unknown') {
    throw new SemanticRuntimeError(
      `runtime cache lock reclaim identity did not respond at ${lockDirectory}; the claim was preserved, retry after confirming its claimant exited`,
    );
  }
  if (legacyReclaim !== 'none') return legacyReclaim === 'reclaimed';

  let ownerToken: string;
  try {
    ownerToken = await readFile(path.join(lockDirectory, 'owner'), 'utf8');
  } catch {
    return claimLegacyRuntimeLock(lockDirectory);
  }
  if (!isVerifiableRuntimeLockOwner(ownerToken)) {
    return claimLegacyRuntimeLock(lockDirectory, ownerToken);
  }

  const released = await exists(runtimeOwnerReleaseFile(lockDirectory, ownerToken));
  if (!released) {
    let lastHeartbeat: number;
    try {
      lastHeartbeat = (await stat(runtimeOwnerHeartbeatFile(lockDirectory, ownerToken))).mtimeMs;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return false;
      if (await exists(runtimeOwnerGenerationFile(lockDirectory, ownerToken))) {
        return reclaimObservedRuntimeLock(lockDirectory, ownerToken);
      }
      return claimLegacyRuntimeLock(lockDirectory, ownerToken);
    }
    if (Date.now() - lastHeartbeat <= runtimeLockStaleMilliseconds) return false;
  }

  if (await exists(runtimeOwnerGenerationFile(lockDirectory, ownerToken))) {
    return reclaimObservedRuntimeLock(lockDirectory, ownerToken);
  }
  return claimLegacyRuntimeLock(lockDirectory, ownerToken);
}

interface PreparedRuntimeLock {
  ownerToken: string;
  stageDirectory: string;
}

async function prepareRuntimeLock(lockDirectory: string): Promise<PreparedRuntimeLock> {
  const ownerToken = randomUUID();
  const stageDirectory = `${lockDirectory}.pending-${ownerToken}`;
  try {
    await mkdir(stageDirectory);
    await writeFile(path.join(stageDirectory, 'owner'), ownerToken, 'utf8');
    await writeFile(runtimeOwnerGenerationFile(stageDirectory, ownerToken), ownerToken, 'utf8');
    await writeFile(runtimeOwnerHeartbeatFile(stageDirectory, ownerToken), ownerToken, 'utf8');
    return { ownerToken, stageDirectory };
  } catch (error: unknown) {
    await rm(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

function isRuntimeLockPublishConflict(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return true;
  return process.platform === 'win32' && (error.code === 'EACCES' || error.code === 'EPERM');
}

async function publishRuntimeLock(lockDirectory: string, preparedLock: PreparedRuntimeLock): Promise<boolean> {
  try {
    await rename(preparedLock.stageDirectory, lockDirectory);
    return true;
  } catch (error: unknown) {
    await rm(preparedLock.stageDirectory, { recursive: true, force: true });
    if (isRuntimeLockPublishConflict(error)) return false;
    throw error;
  }
}

async function acquireRuntimeLock(lockDirectory: string): Promise<RuntimeCacheLease> {
  while (true) {
    const preparedLock = await prepareRuntimeLock(lockDirectory);
    if (await publishRuntimeLock(lockDirectory, preparedLock)) {
      const heartbeatFile = runtimeOwnerHeartbeatFile(lockDirectory, preparedLock.ownerToken);
      const heartbeat = setInterval(() => void utimes(heartbeatFile, new Date(), new Date()).catch(() => undefined), runtimeLockStaleMilliseconds / 3);
      heartbeat.unref();
      return runtimeLockLease(lockDirectory, preparedLock.ownerToken, heartbeat);
    }
    if (await breakStaleRuntimeLock(lockDirectory)) continue;
    await waitForRuntimeLock();
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
