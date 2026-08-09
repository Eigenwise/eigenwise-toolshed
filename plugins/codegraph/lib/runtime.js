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
  reclaimObservedRuntimeLock: () => reclaimObservedRuntimeLock,
  recoverLegacyRuntimeReclaim: () => recoverLegacyRuntimeReclaim,
  recoverRuntimeReclaim: () => recoverRuntimeReclaim,
  runtimePlatformPackage: () => runtimePlatformPackage
});
module.exports = __toCommonJS(runtime_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_net = require("node:net");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("./paths.js");
const runtimeManifestFile = "integrity.json";
const runtimePackageFile = "package.json";
const runtimePackageLockFile = "package-lock.json";
const runtimeModulesDirectory = "node_modules";
const runtimeLockSuffix = ".lock";
const runtimeCurrentFile = "current.json";
const runtimeGenerationsDirectory = "generations";
const runtimeLockStaleMilliseconds = 5 * 60 * 1e3;
const runtimeLockRetryMilliseconds = 25;
const runtimeReclaimProbeTimeoutMilliseconds = 250;
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
function isRuntimeCachePointer(value) {
  return isJsonRecord(value) && typeof value.generation === "string" && /^[a-f0-9-]+$/i.test(value.generation);
}
async function parseJson(filePath) {
  try {
    return JSON.parse(await (0, import_promises.readFile)(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime metadata could not be read: ${filePath}: ${detail}`);
  }
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
async function validatedModulePath(runtimeDirectory, manifest, platformPackage) {
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
  return modulePath;
}
async function validateInstalledRuntime(runtimeDirectory, runtimeKey, manifest, platformPackage) {
  const modulePath = await validatedModulePath(runtimeDirectory, manifest, platformPackage);
  await validateInstalledTree(runtimeDirectory, runtimeKey, manifest);
  await validateFileIntegrity(modulePath, manifest.engine.moduleIntegrity);
}
async function createStageDirectory(cacheDirectory) {
  await (0, import_promises.mkdir)(import_node_path.default.dirname(cacheDirectory), { recursive: true });
  return (0, import_promises.mkdtemp)(import_node_path.default.join(import_node_path.default.dirname(cacheDirectory), `.${import_node_path.default.basename(cacheDirectory)}-staging-`));
}
async function currentRuntimeDirectory(cacheDirectory) {
  const pointerPath = import_node_path.default.join(cacheDirectory, runtimeCurrentFile);
  if (!await exists(pointerPath)) return void 0;
  const pointer = await parseJson(pointerPath);
  if (!isRuntimeCachePointer(pointer)) {
    throw new SemanticRuntimeError(`runtime cache pointer is invalid: ${pointerPath}`);
  }
  return import_node_path.default.join(cacheDirectory, runtimeGenerationsDirectory, pointer.generation);
}
async function publishRuntimeStage(cacheDirectory, stageDirectory, lease) {
  const generation = (0, import_node_crypto.randomUUID)();
  const generationsDirectory = import_node_path.default.join(cacheDirectory, runtimeGenerationsDirectory);
  const generationDirectory = import_node_path.default.join(generationsDirectory, generation);
  const temporaryPointerPath = import_node_path.default.join(cacheDirectory, `.${runtimeCurrentFile}-${generation}`);
  try {
    await lease.assertOwnership();
    await (0, import_promises.mkdir)(generationsDirectory, { recursive: true });
    await (0, import_promises.rename)(stageDirectory, generationDirectory);
    await lease.assertOwnership();
    await (0, import_promises.writeFile)(temporaryPointerPath, JSON.stringify({ generation }), "utf8");
    await (0, import_promises.rename)(temporaryPointerPath, import_node_path.default.join(cacheDirectory, runtimeCurrentFile));
  } catch (error) {
    await (0, import_promises.rm)(temporaryPointerPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new SemanticRuntimeError(`runtime cache could not be published: ${detail}`);
  }
}
function waitForRuntimeLock() {
  return new Promise((resolve) => setTimeout(resolve, runtimeLockRetryMilliseconds));
}
function runtimeOwnerGenerationFile(lockDirectory, ownerToken) {
  return import_node_path.default.join(lockDirectory, `generation-${ownerToken}`);
}
function runtimeOwnerHeartbeatFile(lockDirectory, ownerToken) {
  return import_node_path.default.join(lockDirectory, `owner-${ownerToken}`);
}
function runtimeOwnerReleaseFile(lockDirectory, ownerToken) {
  return import_node_path.default.join(lockDirectory, `released-${ownerToken}`);
}
async function releaseRuntimeLock(lockDirectory, ownerToken) {
  await (0, import_promises.writeFile)(runtimeOwnerReleaseFile(lockDirectory, ownerToken), "released", { flag: "wx" }).catch(() => void 0);
}
function runtimeLockLease(lockDirectory, ownerToken, heartbeat) {
  return {
    async assertOwnership() {
      try {
        const [currentOwnerToken, generationToken] = await Promise.all([
          (0, import_promises.readFile)(import_node_path.default.join(lockDirectory, "owner"), "utf8"),
          (0, import_promises.readFile)(runtimeOwnerGenerationFile(lockDirectory, ownerToken), "utf8")
        ]);
        if (currentOwnerToken === ownerToken && generationToken === ownerToken) return;
      } catch {
      }
      throw new SemanticRuntimeError("runtime cache lock ownership was lost");
    },
    async release() {
      clearInterval(heartbeat);
      await releaseRuntimeLock(lockDirectory, ownerToken);
    }
  };
}
function isVerifiableRuntimeLockOwner(ownerToken) {
  return /^[a-f0-9-]{36}$/i.test(ownerToken);
}
const runtimeReclaimMarkerPattern = /^reclaim-([a-f0-9-]{36})\.(\d+)\.([a-f0-9-]{36})$/i;
async function openRuntimeReclaimGuard() {
  const token = (0, import_node_crypto.randomUUID)();
  const server = (0, import_node_net.createServer)((socket) => socket.end(token));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new SemanticRuntimeError("runtime reclaim guard did not bind a TCP port");
  }
  server.unref();
  return { port: address.port, server, token };
}
async function closeRuntimeReclaimGuard(guard) {
  await new Promise((resolve) => guard.server.close(() => resolve()));
}
function runtimeReclaimMarker(lockDirectory, generationToken, identity) {
  return import_node_path.default.join(lockDirectory, `reclaim-${generationToken}.${identity.port}.${identity.token}`);
}
function parseRuntimeReclaimMarker(fileName) {
  const match = runtimeReclaimMarkerPattern.exec(fileName);
  if (match === null) return void 0;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return void 0;
  return { generationToken: match[1], identity: { port, token: match[3] } };
}
async function runtimeReclaimerIdentityStatus(identity) {
  return new Promise((resolve) => {
    let response = "";
    let settled = false;
    const socket = (0, import_node_net.createConnection)({ host: "127.0.0.1", port: identity.port });
    const timeout = setTimeout(() => finish("unknown"), runtimeReclaimProbeTimeoutMilliseconds);
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(status);
    };
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      response += data;
      if (response.length >= identity.token.length) {
        finish(response === identity.token ? "live" : "dead");
      }
    });
    socket.once("end", () => finish(response === identity.token ? "live" : "dead"));
    socket.once("error", (error) => {
      finish(error.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
  });
}
async function moveClaimedRuntimeLock(lockDirectory, claimMarker, guard) {
  const staleDirectory = `${lockDirectory}.stale-${(0, import_node_crypto.randomUUID)()}`;
  try {
    await (0, import_promises.access)(claimMarker);
    await (0, import_promises.rename)(lockDirectory, staleDirectory);
    await (0, import_promises.rm)(staleDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    await closeRuntimeReclaimGuard(guard);
  }
}
async function continueRuntimeReclaim(lockDirectory, observedMarker, generationToken) {
  const guard = await openRuntimeReclaimGuard();
  const claimMarker = runtimeReclaimMarker(lockDirectory, generationToken, guard);
  try {
    await (0, import_promises.rename)(observedMarker, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}
async function recoverRuntimeReclaim(lockDirectory) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(lockDirectory);
  } catch {
    return "none";
  }
  for (const entry of entries) {
    const reclaim = parseRuntimeReclaimMarker(entry);
    if (reclaim === void 0) continue;
    const identityStatus = await runtimeReclaimerIdentityStatus(reclaim.identity);
    if (identityStatus === "live") return "active";
    if (identityStatus === "unknown") return "unknown";
    return await continueRuntimeReclaim(
      lockDirectory,
      import_node_path.default.join(lockDirectory, entry),
      reclaim.generationToken
    ) ? "reclaimed" : "active";
  }
  return "none";
}
function parseLegacyRuntimeReclaim(value) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return void 0;
    if (!("generationToken" in parsed) || !("port" in parsed) || !("token" in parsed)) return void 0;
    if (typeof parsed.generationToken !== "string" || !isVerifiableRuntimeLockOwner(parsed.generationToken)) return void 0;
    if (typeof parsed.token !== "string" || !isVerifiableRuntimeLockOwner(parsed.token)) return void 0;
    if (typeof parsed.port !== "number" || !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) return void 0;
    return { generationToken: parsed.generationToken, port: parsed.port, token: parsed.token };
  } catch {
    return void 0;
  }
}
async function recoverLegacyRuntimeReclaim(lockDirectory) {
  const claimFile = import_node_path.default.join(lockDirectory, "legacy-reclaim");
  let reclaim;
  try {
    const parsed = parseLegacyRuntimeReclaim(await (0, import_promises.readFile)(claimFile, "utf8"));
    if (parsed === void 0) {
      return await continueRuntimeReclaim(lockDirectory, claimFile, (0, import_node_crypto.randomUUID)()) ? "reclaimed" : "active";
    }
    reclaim = parsed;
  } catch {
    return "none";
  }
  const identityStatus = await runtimeReclaimerIdentityStatus(reclaim);
  if (identityStatus === "live") return "active";
  if (identityStatus === "unknown") return "unknown";
  return await continueRuntimeReclaim(lockDirectory, claimFile, reclaim.generationToken) ? "reclaimed" : "active";
}
async function claimLegacyRuntimeLock(lockDirectory, observedOwnerToken) {
  const guard = await openRuntimeReclaimGuard();
  const generationToken = (0, import_node_crypto.randomUUID)();
  const preparedClaimFile = import_node_path.default.join(lockDirectory, `.legacy-reclaim-${generationToken}`);
  const claimFile = import_node_path.default.join(lockDirectory, "legacy-reclaim");
  const serializedClaim = JSON.stringify({ generationToken, port: guard.port, token: guard.token });
  try {
    await (0, import_promises.writeFile)(preparedClaimFile, serializedClaim, { flag: "wx" });
    await (0, import_promises.link)(preparedClaimFile, claimFile);
    await (0, import_promises.rm)(preparedClaimFile, { force: true });
  } catch {
    await (0, import_promises.rm)(preparedClaimFile, { force: true });
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  try {
    const entries = await (0, import_promises.readdir)(lockDirectory);
    if (entries.some((entry) => entry.startsWith("generation-"))) {
      await (0, import_promises.rm)(claimFile, { force: true });
      await closeRuntimeReclaimGuard(guard);
      return false;
    }
    if (observedOwnerToken !== void 0) {
      const currentOwnerToken = await (0, import_promises.readFile)(import_node_path.default.join(lockDirectory, "owner"), "utf8");
      if (currentOwnerToken !== observedOwnerToken) {
        await (0, import_promises.rm)(claimFile, { force: true });
        await closeRuntimeReclaimGuard(guard);
        return false;
      }
    }
  } catch {
    await (0, import_promises.rm)(claimFile, { force: true });
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  const claimMarker = runtimeReclaimMarker(lockDirectory, generationToken, guard);
  try {
    await (0, import_promises.rename)(claimFile, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}
async function reclaimObservedRuntimeLock(lockDirectory, ownerToken) {
  try {
    if (await (0, import_promises.readFile)(import_node_path.default.join(lockDirectory, "owner"), "utf8") !== ownerToken) return false;
  } catch {
    return false;
  }
  if (!await exists(runtimeOwnerReleaseFile(lockDirectory, ownerToken))) {
    try {
      const lastHeartbeat = (await (0, import_promises.stat)(runtimeOwnerHeartbeatFile(lockDirectory, ownerToken))).mtimeMs;
      if (Date.now() - lastHeartbeat <= runtimeLockStaleMilliseconds) return false;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
    }
  }
  const guard = await openRuntimeReclaimGuard();
  const generationFile = runtimeOwnerGenerationFile(lockDirectory, ownerToken);
  const claimMarker = runtimeReclaimMarker(lockDirectory, ownerToken, guard);
  try {
    await (0, import_promises.rename)(generationFile, claimMarker);
  } catch {
    await closeRuntimeReclaimGuard(guard);
    return false;
  }
  return moveClaimedRuntimeLock(lockDirectory, claimMarker, guard);
}
async function breakStaleRuntimeLock(lockDirectory) {
  const generatedReclaim = await recoverRuntimeReclaim(lockDirectory);
  if (generatedReclaim === "unknown") {
    throw new SemanticRuntimeError(
      `runtime cache lock reclaim identity did not respond at ${lockDirectory}; the claim was preserved, retry after confirming its claimant exited`
    );
  }
  if (generatedReclaim !== "none") return generatedReclaim === "reclaimed";
  const legacyReclaim = await recoverLegacyRuntimeReclaim(lockDirectory);
  if (legacyReclaim === "unknown") {
    throw new SemanticRuntimeError(
      `runtime cache lock reclaim identity did not respond at ${lockDirectory}; the claim was preserved, retry after confirming its claimant exited`
    );
  }
  if (legacyReclaim !== "none") return legacyReclaim === "reclaimed";
  let ownerToken;
  try {
    ownerToken = await (0, import_promises.readFile)(import_node_path.default.join(lockDirectory, "owner"), "utf8");
  } catch {
    return claimLegacyRuntimeLock(lockDirectory);
  }
  if (!isVerifiableRuntimeLockOwner(ownerToken)) {
    return claimLegacyRuntimeLock(lockDirectory, ownerToken);
  }
  const released = await exists(runtimeOwnerReleaseFile(lockDirectory, ownerToken));
  if (!released) {
    let lastHeartbeat;
    try {
      lastHeartbeat = (await (0, import_promises.stat)(runtimeOwnerHeartbeatFile(lockDirectory, ownerToken))).mtimeMs;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
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
async function prepareRuntimeLock(lockDirectory) {
  const ownerToken = (0, import_node_crypto.randomUUID)();
  const stageDirectory = `${lockDirectory}.pending-${ownerToken}`;
  try {
    await (0, import_promises.mkdir)(stageDirectory);
    await (0, import_promises.writeFile)(import_node_path.default.join(stageDirectory, "owner"), ownerToken, "utf8");
    await (0, import_promises.writeFile)(runtimeOwnerGenerationFile(stageDirectory, ownerToken), ownerToken, "utf8");
    await (0, import_promises.writeFile)(runtimeOwnerHeartbeatFile(stageDirectory, ownerToken), ownerToken, "utf8");
    return { ownerToken, stageDirectory };
  } catch (error) {
    await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}
function isRuntimeLockPublishConflict(error) {
  if (!(error instanceof Error) || !("code" in error)) return false;
  if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return true;
  return process.platform === "win32" && (error.code === "EACCES" || error.code === "EPERM");
}
async function publishRuntimeLock(lockDirectory, preparedLock) {
  try {
    await (0, import_promises.rename)(preparedLock.stageDirectory, lockDirectory);
    return true;
  } catch (error) {
    await (0, import_promises.rm)(preparedLock.stageDirectory, { recursive: true, force: true });
    if (isRuntimeLockPublishConflict(error)) return false;
    throw error;
  }
}
async function acquireRuntimeLock(lockDirectory) {
  while (true) {
    const preparedLock = await prepareRuntimeLock(lockDirectory);
    if (await publishRuntimeLock(lockDirectory, preparedLock)) {
      const heartbeatFile = runtimeOwnerHeartbeatFile(lockDirectory, preparedLock.ownerToken);
      const heartbeat = setInterval(() => void (0, import_promises.utimes)(heartbeatFile, /* @__PURE__ */ new Date(), /* @__PURE__ */ new Date()).catch(() => void 0), runtimeLockStaleMilliseconds / 3);
      heartbeat.unref();
      return runtimeLockLease(lockDirectory, preparedLock.ownerToken, heartbeat);
    }
    if (await breakStaleRuntimeLock(lockDirectory)) continue;
    await waitForRuntimeLock();
  }
}
async function withRuntimeCacheLock(cacheDirectory, action) {
  const lockDirectory = `${cacheDirectory}${runtimeLockSuffix}`;
  await (0, import_promises.mkdir)(import_node_path.default.dirname(cacheDirectory), { recursive: true });
  const lease = await acquireRuntimeLock(lockDirectory);
  try {
    return await action(lease);
  } finally {
    await lease.release();
  }
}
class TypeScriptRuntimeAcquirer {
  architecture;
  environment;
  installer;
  platform;
  runtimeManifestDirectory;
  stateDirectory;
  userHomeDirectory;
  constructor(options = {}) {
    this.architecture = options.architecture ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.installer = options.installer ?? new NpmRuntimeInstaller();
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
    return withRuntimeCacheLock(cacheDirectory, (lease) => this.acquireLockedRuntime(cacheDirectory, lease));
  }
  async acquireLockedRuntime(cacheDirectory, lease) {
    const manifest = await readRuntimeManifest(this.runtimeManifestDirectory);
    const packageLock = await readPackageLock(this.runtimeManifestDirectory);
    validateManifestLock(manifest, packageLock);
    const packageName = runtimePlatformPackage(manifest, this.platform, this.architecture);
    const runtimeKey = platformKey(this.platform, this.architecture);
    const cachedRuntimeDirectory = await currentRuntimeDirectory(cacheDirectory).catch(() => void 0);
    if (cachedRuntimeDirectory !== void 0) {
      try {
        await validateInstalledRuntime(cachedRuntimeDirectory, runtimeKey, manifest, packageName);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      } catch (error) {
        await this.replaceIncompleteCache(cacheDirectory, runtimeKey, manifest, packageName, lease, error);
        return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
      }
    }
    await this.installCache(cacheDirectory, runtimeKey, manifest, packageName, lease);
    return new LoadedTypeScriptRuntime(manifest.engine.id, manifest.engine.version);
  }
  async replaceIncompleteCache(cacheDirectory, runtimeKey, manifest, packageName, lease, previousError) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await publishRuntimeStage(cacheDirectory, stageDirectory, lease);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new SemanticRuntimeError(`runtime cache recovery failed after ${String(previousError)}: ${detail}`);
    }
  }
  async installCache(cacheDirectory, runtimeKey, manifest, packageName, lease) {
    const stageDirectory = await this.createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName);
    try {
      await publishRuntimeStage(cacheDirectory, stageDirectory, lease);
    } catch (error) {
      await (0, import_promises.rm)(stageDirectory, { recursive: true, force: true });
      const existingRuntimeDirectory = await currentRuntimeDirectory(cacheDirectory).catch(() => void 0);
      if (existingRuntimeDirectory !== void 0) {
        await validateInstalledRuntime(existingRuntimeDirectory, runtimeKey, manifest, packageName);
        return;
      }
      throw error;
    }
  }
  async createValidatedStage(cacheDirectory, runtimeKey, manifest, packageName) {
    const stageDirectory = await createStageDirectory(cacheDirectory);
    try {
      await this.installer.install(stageDirectory, this.runtimeManifestDirectory);
      await validateInstalledRuntime(stageDirectory, runtimeKey, manifest, packageName);
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
  reclaimObservedRuntimeLock,
  recoverLegacyRuntimeReclaim,
  recoverRuntimeReclaim,
  runtimePlatformPackage
});
