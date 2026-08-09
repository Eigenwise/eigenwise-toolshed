"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var runtime_exports = {};
__export(runtime_exports, {
  NpmRuntimeInstaller: () => NpmRuntimeInstaller,
  SemanticRuntimeError: () => SemanticRuntimeError,
  TypeScriptRuntimeAcquirer: () => TypeScriptRuntimeAcquirer,
  UnsupportedRuntimePlatformError: () => UnsupportedRuntimePlatformError,
  runtimePlatformPackage: () => runtimePlatformPackage
});
module.exports = __toCommonJS(runtime_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_paths = require("./paths.js");
const runtimeManifestFile = "integrity.json";
const runtimePackageFile = "package.json";
const runtimePackageLockFile = "package-lock.json";
const runtimeModulesDirectory = "node_modules";
const runtimeLockSuffix = ".lock";
const runtimeLockStaleMilliseconds = 5 * 60 * 1e3;
const runtimeLockRetryMilliseconds = 25;
const inFlightAcquisitions = /* @__PURE__ */ new Map();
class SemanticRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SemanticRuntimeError";
  }
}
class UnsupportedRuntimePlatformError extends SemanticRuntimeError {
  constructor(platform, architecture) {
    super(`TypeScript semantic runtime does not support ${platform}-${architecture}`);
    this.name = "UnsupportedRuntimePlatformError";
  }
}
function isJsonRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPackageIntegrity(value) {
  return isJsonRecord(value) && typeof value.version === "string" && typeof value.integrity === "string";
}
function isStringMap(value) {
  return isJsonRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
function isPackageIntegrityMap(value) {
  return isJsonRecord(value) && Object.values(value).every(isPackageIntegrity);
}
function isRuntimeManifest(value) {
  if (!isJsonRecord(value) || !isJsonRecord(value.engine)) return false;
  const { engine, installedTreeIntegrity: installedTreeIntegrity2, packages, platformPackages } = value;
  return typeof engine.id === "string" && typeof engine.version === "string" && typeof engine.module === "string" && typeof engine.moduleFile === "string" && typeof engine.moduleIntegrity === "string" && isPackageIntegrityMap(packages) && isStringMap(installedTreeIntegrity2) && isStringMap(platformPackages);
}
function isPackageLock(value) {
  return isJsonRecord(value) && isJsonRecord(value.packages);
}
async function parseJson(filePath) {
  return JSON.parse(await (0, import_promises.readFile)(filePath, "utf8"));
}
async function readRuntimeManifest(runtimeManifestDirectory) {
  const manifest = await parseJson(import_node_path.default.join(runtimeManifestDirectory, runtimeManifestFile));
  if (!isRuntimeManifest(manifest)) {
    throw new SemanticRuntimeError(`runtime integrity manifest is invalid: ${runtimeManifestDirectory}`);
  }
  return manifest;
}
async function readPackageLock(runtimeManifestDirectory) {
  const packageLock = await parseJson(import_node_path.default.join(runtimeManifestDirectory, runtimePackageLockFile));
  if (!isPackageLock(packageLock)) {
    throw new SemanticRuntimeError(`runtime package lock is invalid: ${runtimeManifestDirectory}`);
  }
  return packageLock;
}
function lockPackageKey(packageName) {
  return `node_modules/${packageName}`;
}
function validateLockedPackage(packageLock, packageName, expected) {
  const locked = packageLock.packages[lockPackageKey(packageName)];
  if (!isPackageIntegrity(locked) || locked.version !== expected.version || locked.integrity !== expected.integrity) {
    throw new SemanticRuntimeError(`runtime lock integrity mismatch for ${packageName}`);
  }
}
function platformKey(platform, architecture) {
  return `${platform}-${architecture}`;
}
function runtimePlatformPackage(manifest, platform = process.platform, architecture = process.arch) {
  const packageName = manifest.platformPackages[platformKey(platform, architecture)];
  if (packageName === void 0) {
    throw new UnsupportedRuntimePlatformError(platform, architecture);
  }
  return packageName;
}
function validateManifestLock(manifest, packageLock) {
  for (const [packageName, expected] of Object.entries(manifest.packages)) {
    validateLockedPackage(packageLock, packageName, expected);
  }
  const enginePackage = manifest.packages[manifest.engine.id];
  if (enginePackage?.version !== manifest.engine.version) {
    throw new SemanticRuntimeError("runtime engine version does not match its integrity manifest");
  }
  for (const packageName of Object.values(manifest.platformPackages)) {
    if (manifest.packages[packageName] === void 0) {
      throw new SemanticRuntimeError(`runtime platform package is not pinned: ${packageName}`);
    }
  }
}
async function exists(directory) {
  try {
    await (0, import_promises.access)(directory);
    return true;
  } catch {
    return false;
  }
}
async function copyRuntimeManifest(runtimeManifestDirectory, stageDirectory) {
  await Promise.all([
    (0, import_promises.copyFile)(import_node_path.default.join(runtimeManifestDirectory, runtimePackageFile), import_node_path.default.join(stageDirectory, runtimePackageFile)),
    (0, import_promises.copyFile)(import_node_path.default.join(runtimeManifestDirectory, runtimePackageLockFile), import_node_path.default.join(stageDirectory, runtimePackageLockFile))
  ]);
}
function waitForProcess(command, arguments_, workingDirectory) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)(command, arguments_, {
      cwd: workingDirectory,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new SemanticRuntimeError(`runtime install failed with exit code ${code ?? "unknown"}`));
      }
    });
  });
}
class NpmRuntimeInstaller {
  async install(stageDirectory, runtimeManifestDirectory) {
    await copyRuntimeManifest(runtimeManifestDirectory, stageDirectory);
    const npmCli = import_node_path.default.join(import_node_path.default.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    await waitForProcess(process.execPath, [npmCli, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--fund=false"], stageDirectory);
  }
}
class ImportRuntimeModuleLoader {
  async load(modulePath) {
    return import((0, import_node_url.pathToFileURL)(modulePath).href);
  }
}
class LoadedTypeScriptRuntime {
  engineId;
  engineVersion;
  extractors = [];
  constructor(engineId, engineVersion) {
    this.engineId = engineId;
    this.engineVersion = engineVersion;
  }
}
function packageExportPath(packageMetadata, moduleSpecifier, packageName) {
  const modulePrefix = `${packageName}/`;
  if (!moduleSpecifier.startsWith(modulePrefix)) {
    throw new SemanticRuntimeError(`runtime module is outside its package: ${moduleSpecifier}`);
  }
  const exportKey = `./${moduleSpecifier.slice(modulePrefix.length)}`;
  const exports2 = packageMetadata.exports;
  if (!isJsonRecord(exports2) || typeof exports2[exportKey] !== "string") {
    throw new SemanticRuntimeError(`runtime package does not export ${moduleSpecifier}`);
  }
  return exports2[exportKey];
}
async function validateFileIntegrity(filePath, expectedIntegrity) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expectedIntegrity)) {
    throw new SemanticRuntimeError(`runtime module integrity is invalid: ${filePath}`);
  }
  const content = await (0, import_promises.readFile)(filePath);
  const actualIntegrity = `sha512-${(0, import_node_crypto.createHash)("sha512").update(content).digest("base64")}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new SemanticRuntimeError(`runtime module integrity mismatch: ${filePath}`);
  }
}
async function installedTreeIntegrity(directory) {
  const hash = (0, import_node_crypto.createHash)("sha512");
  async function hashDirectory(currentDirectory) {
    const entries = await (0, import_promises.readdir)(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = import_node_path.default.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await hashDirectory(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new SemanticRuntimeError(`runtime tree contains an unsupported entry: ${entryPath}`);
      }
      hash.update(import_node_path.default.relative(directory, entryPath).split(import_node_path.default.sep).join("/"));
      hash.update("\0");
      hash.update(await (0, import_promises.readFile)(entryPath));
      hash.update("\0");
    }
  }
  await hashDirectory(directory);
  return `sha512-${hash.digest("base64")}`;
}
async function validateInstalledTree(runtimeDirectory, runtimeKey, manifest) {
  const expectedIntegrity = manifest.installedTreeIntegrity[runtimeKey];
  if (expectedIntegrity === void 0) {
    throw new SemanticRuntimeError(`runtime tree integrity is not pinned: ${runtimeKey}`);
  }
  const actualIntegrity = await installedTreeIntegrity(import_node_path.default.join(runtimeDirectory, runtimeModulesDirectory));
  if (actualIntegrity !== expectedIntegrity) {
    throw new SemanticRuntimeError(`runtime tree integrity mismatch: ${runtimeKey}`);
  }
}
async function validateInstalledRuntime(runtimeDirectory, runtimeKey, manifest, platformPackage, moduleLoader) {
  let engineMetadata;
  for (const packageName of [manifest.engine.id, platformPackage]) {
    const expected = manifest.packages[packageName];
    if (expected === void 0) {
      throw new SemanticRuntimeError(`runtime package is not pinned: ${packageName}`);
    }
    const packageMetadata = await parseJson(import_node_path.default.join(runtimeDirectory, runtimeModulesDirectory, packageName, runtimePackageFile));
    if (!isJsonRecord(packageMetadata) || packageMetadata.version !== expected.version) {
      throw new SemanticRuntimeError(`runtime package version mismatch for ${packageName}`);
    }
    if (packageName === manifest.engine.id) engineMetadata = packageMetadata;
  }
  if (engineMetadata === void 0) {
    throw new SemanticRuntimeError(`runtime engine package is missing: ${manifest.engine.id}`);
  }
  const exportedModuleFile = packageExportPath(engineMetadata, manifest.engine.module, manifest.engine.id);
  if (exportedModuleFile !== manifest.engine.moduleFile) {
    throw new SemanticRuntimeError(`runtime module export changed: ${manifest.engine.module}`);
  }
  const engineDirectory = import_node_path.default.resolve(runtimeDirectory, runtimeModulesDirectory, manifest.engine.id);
  const modulePath = import_node_path.default.resolve(engineDirectory, manifest.engine.moduleFile);
  if (!modulePath.startsWith(`${engineDirectory}${import_node_path.default.sep}`)) {
    throw new SemanticRuntimeError(`runtime module escapes its package: ${manifest.engine.moduleFile}`);
  }
  await validateInstalledTree(runtimeDirectory, runtimeKey, manifest);
  await validateFileIntegrity(modulePath, manifest.engine.moduleIntegrity);
  try {
    await moduleLoader.load(modulePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime module could not load: ${detail}`);
  }
}
async function createStageDirectory(cacheDirectory) {
  await (0, import_promises.mkdir)(import_node_path.default.dirname(cacheDirectory), { recursive: true });
  return (0, import_promises.mkdtemp)(import_node_path.default.join(import_node_path.default.dirname(cacheDirectory), `.${import_node_path.default.basename(cacheDirectory)}-staging-`));
}
function waitForRuntimeLock() {
  return new Promise((resolve) => setTimeout(resolve, runtimeLockRetryMilliseconds));
}
async function releaseRuntimeLock(lockDirectory, ownerFile, ownerToken) {
  try {
    if (await (0, import_promises.readFile)(ownerFile, "utf8") === ownerToken) {
      await (0, import_promises.rm)(lockDirectory, { recursive: true, force: true });
    }
  } catch {
  }
}
async function breakStaleRuntimeLock(lockDirectory) {
  const ownerFile = import_node_path.default.join(lockDirectory, "owner");
  let lastHeartbeat;
  try {
    lastHeartbeat = (await (0, import_promises.stat)(ownerFile)).mtimeMs;
  } catch {
    lastHeartbeat = (await (0, import_promises.stat)(lockDirectory)).mtimeMs;
  }
  if (Date.now() - lastHeartbeat <= runtimeLockStaleMilliseconds) return false;
  const staleDirectory = `${lockDirectory}.stale-${(0, import_node_crypto.randomUUID)()}`;
  try {
    await (0, import_promises.rename)(lockDirectory, staleDirectory);
    await (0, import_promises.rm)(staleDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
async function acquireRuntimeLock(lockDirectory) {
  while (true) {
    try {
      await (0, import_promises.mkdir)(lockDirectory);
      const ownerFile = import_node_path.default.join(lockDirectory, "owner");
      const ownerToken = (0, import_node_crypto.randomUUID)();
      await (0, import_promises.writeFile)(ownerFile, ownerToken, "utf8");
      const heartbeat = setInterval(() => void (0, import_promises.utimes)(ownerFile, /* @__PURE__ */ new Date(), /* @__PURE__ */ new Date()).catch(() => void 0), runtimeLockStaleMilliseconds / 3);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await releaseRuntimeLock(lockDirectory, ownerFile, ownerToken);
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      if (await breakStaleRuntimeLock(lockDirectory)) continue;
      await waitForRuntimeLock();
    }
  }
}
async function withRuntimeCacheLock(cacheDirectory, action) {
  const lockDirectory = `${cacheDirectory}${runtimeLockSuffix}`;
  await (0, import_promises.mkdir)(import_node_path.default.dirname(cacheDirectory), { recursive: true });
  const releaseLock = await acquireRuntimeLock(lockDirectory);
  try {
    return await action();
  } finally {
    await releaseLock();
  }
}
class TypeScriptRuntimeAcquirer {
  architecture;
  environment;
  installer;
  moduleLoader;
  platform;
  runtimeManifestDirectory;
  stateDirectory;
  userHomeDirectory;
  constructor(options = {}) {
    this.architecture = options.architecture ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.installer = options.installer ?? new NpmRuntimeInstaller();
    this.moduleLoader = options.moduleLoader ?? new ImportRuntimeModuleLoader();
    this.platform = options.platform ?? process.platform;
    this.runtimeManifestDirectory = options.runtimeManifestDirectory ?? import_node_path.default.resolve(__dirname, "..", "runtime");
    this.stateDirectory = options.stateDirectory;
    this.userHomeDirectory = options.userHomeDirectory;
  }
  acquire() {
    const cacheDirectory = this.cacheDirectory();
    const existing = inFlightAcquisitions.get(cacheDirectory);
    if (existing !== void 0) return existing;
    const acquisition = this.acquireRuntime(cacheDirectory).finally(() => {
      inFlightAcquisitions.delete(cacheDirectory);
    });
    inFlightAcquisitions.set(cacheDirectory, acquisition);
    return acquisition;
  }
  cacheDirectory() {
    if (this.stateDirectory !== void 0) {
      return import_node_path.default.join(this.stateDirectory, "runtime", "7.0.2", platformKey(this.platform, this.architecture));
    }
    return (0, import_paths.runtimeCacheDirectory)("7.0.2", this.platform, this.architecture, this.environment, this.userHomeDirectory);
  }
  async acquireRuntime(cacheDirectory) {
    return withRuntimeCacheLock(cacheDirectory, () => this.acquireLockedRuntime(cacheDirectory));
  }
  async acquireLockedRuntime(cacheDirectory) {
    const manifest = await readRuntimeManifest(this.runtimeManifestDirectory);
    const packageLock = await readPackageLock(this.runtimeManifestDirectory);
    validateManifestLock(manifest, packageLock);
    const packageName = runtimePlatformPackage(manifest, this.platform, this.architecture);
    const runtimeKey = platformKey(this.platform, this.architecture);
    if (await exists(cacheDirectory)) {
      try {
        await validateInstalledRuntime(cacheDirectory, runtimeKey, manifest, packageName, this.moduleLoader);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      } catch (error) {
        await this.replaceIncompleteCache(cacheDirectory, runtimeKey, manifest, packageName, error);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      }
    }
    await this.installCache(cacheDirectory, runtimeKey, manifest, packageName);
    return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
  }
  async replaceIncompleteCache(cacheDirectory, runtimeKey, manifest, packageName, previousError) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await (0, import_promises.rm)(cacheDirectory, { recursive: true, force: true });
      await (0, import_promises.rename)(stageDirectory, cacheDirectory);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache recovery failed after ${String(previousError)}: ${detail}`);
    }
  }
  async installCache(cacheDirectory, runtimeKey, manifest, packageName) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await (0, import_promises.rename)(stageDirectory, cacheDirectory);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      if (await exists(cacheDirectory)) {
        await validateInstalledRuntime(cacheDirectory, runtimeKey, manifest, packageName, this.moduleLoader);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache could not be published: ${detail}`);
    }
  }
  async createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName) {
    const stageDirectory = await createStageDirectory(cacheDirectory);
    try {
      await this.installer.install(stageDirectory, this.runtimeManifestDirectory);
      await validateInstalledRuntime(stageDirectory, runtimeKey, manifest, packageName, this.moduleLoader);
      return stageDirectory;
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NpmRuntimeInstaller,
  SemanticRuntimeError,
  TypeScriptRuntimeAcquirer,
  UnsupportedRuntimePlatformError,
  runtimePlatformPackage
});
