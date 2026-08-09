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
var installed_plugins_exports = {};
__export(installed_plugins_exports, {
  writeInstalledPluginsAtomically: () => writeInstalledPluginsAtomically
});
module.exports = __toCommonJS(installed_plugins_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
const registryLockTimeoutMilliseconds = 1e4;
const registryLockRetryMilliseconds = 10;
function temporaryRegistryPath(registryPath) {
  return import_node_path.default.join(import_node_path.default.dirname(registryPath), `.${import_node_path.default.basename(registryPath)}.${process.pid}.${(0, import_node_crypto.randomUUID)()}.tmp`);
}
function errorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : void 0;
}
function waitForRegistryLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, registryLockRetryMilliseconds);
}
function acquireRegistryLock(registryPath) {
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + registryLockTimeoutMilliseconds;
  for (; ; ) {
    try {
      return { descriptor: import_node_fs.default.openSync(lockPath, "wx"), path: lockPath };
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || Date.now() >= deadline) throw error;
      waitForRegistryLock();
    }
  }
}
function replaceRegistryFile(temporaryPath, registryPath) {
  const deadline = Date.now() + registryLockTimeoutMilliseconds;
  for (; ; ) {
    try {
      import_node_fs.default.renameSync(temporaryPath, registryPath);
      return;
    } catch (error) {
      if (errorCode(error) !== "EPERM" || Date.now() >= deadline) throw error;
      waitForRegistryLock();
    }
  }
}
function writeInstalledPluginsAtomically(registryPath, contents) {
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(registryPath), { recursive: true });
  const lock = acquireRegistryLock(registryPath);
  const temporaryPath = temporaryRegistryPath(registryPath);
  try {
    import_node_fs.default.writeFileSync(temporaryPath, contents, "utf8");
    replaceRegistryFile(temporaryPath, registryPath);
  } finally {
    import_node_fs.default.rmSync(temporaryPath, { force: true });
    import_node_fs.default.closeSync(lock.descriptor);
    import_node_fs.default.rmSync(lock.path, { force: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  writeInstalledPluginsAtomically
});
