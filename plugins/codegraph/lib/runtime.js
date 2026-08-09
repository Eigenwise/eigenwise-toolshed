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
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("./paths.js");
const runtimeManifestFile = "integrity.json";
const runtimePackageFile = "package.json";
const runtimePackageLockFile = "package-lock.json";
const runtimeModulesDirectory = "node_modules";
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
  const { engine, packages, platformPackages } = value;
  return typeof engine.id === "string" && typeof engine.version === "string" && typeof engine.module === "string" && isPackageIntegrityMap(packages) && isStringMap(platformPackages);
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
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    await waitForProcess(command, ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--fund=false"], stageDirectory);
  }
}
class RequireRuntimeModuleLoader {
  load(modulePath) {
    return require(modulePath);
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
async function validateInstalledRuntime(runtimeDirectory, manifest, platformPackage, moduleLoader) {
  for (const packageName of [manifest.engine.id, platformPackage]) {
    const expected = manifest.packages[packageName];
    if (expected === void 0) {
      throw new SemanticRuntimeError(`runtime package is not pinned: ${packageName}`);
    }
    const packageMetadata = await parseJson(import_node_path.default.join(runtimeDirectory, runtimeModulesDirectory, packageName, runtimePackageFile));
    if (!isJsonRecord(packageMetadata) || packageMetadata.version !== expected.version) {
      throw new SemanticRuntimeError(`runtime package version mismatch for ${packageName}`);
    }
  }
  const modulePath = import_node_path.default.join(runtimeDirectory, runtimeModulesDirectory, manifest.engine.module);
  try {
    moduleLoader.load(modulePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime module could not load: ${detail}`);
  }
}
async function createStageDirectory(cacheDirectory) {
  await (0, import_promises.mkdir)(import_node_path.default.dirname(cacheDirectory), { recursive: true });
  return (0, import_promises.mkdtemp)(import_node_path.default.join(import_node_path.default.dirname(cacheDirectory), `.${import_node_path.default.basename(cacheDirectory)}-staging-`));
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
    this.moduleLoader = options.moduleLoader ?? new RequireRuntimeModuleLoader();
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
    const manifest = await readRuntimeManifest(this.runtimeManifestDirectory);
    const packageLock = await readPackageLock(this.runtimeManifestDirectory);
    validateManifestLock(manifest, packageLock);
    const packageName = runtimePlatformPackage(manifest, this.platform, this.architecture);
    if (await exists(cacheDirectory)) {
      try {
        await validateInstalledRuntime(cacheDirectory, manifest, packageName, this.moduleLoader);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      } catch (error) {
        await this.replaceIncompleteCache(cacheDirectory, manifest, packageName, error);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      }
    }
    await this.installCache(cacheDirectory, manifest, packageName);
    return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
  }
  async replaceIncompleteCache(cacheDirectory, manifest, packageName, previousError) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, manifest, packageName);
    try {
      await (0, import_promises.rm)(cacheDirectory, { recursive: true, force: true });
      await (0, import_promises.rename)(stageDirectory, cacheDirectory);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache recovery failed after ${String(previousError)}: ${detail}`);
    }
  }
  async installCache(cacheDirectory, manifest, packageName) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, manifest, packageName);
    try {
      await (0, import_promises.rename)(stageDirectory, cacheDirectory);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      if (await exists(cacheDirectory)) {
        await validateInstalledRuntime(cacheDirectory, manifest, packageName, this.moduleLoader);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache could not be published: ${detail}`);
    }
  }
  async createValidatedStage(cacheDirectory, manifest, packageName) {
    const stageDirectory = await createStageDirectory(cacheDirectory);
    try {
      await this.installer.install(stageDirectory, this.runtimeManifestDirectory);
      await validateInstalledRuntime(stageDirectory, manifest, packageName, this.moduleLoader);
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
