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
  PyrightRuntimeAcquirer: () => PyrightRuntimeAcquirer,
  pyrightEngineId: () => pyrightEngineId,
  pyrightEngineVersion: () => pyrightEngineVersion
});
module.exports = __toCommonJS(runtime_exports);
var import_node_path = __toESM(require("node:path"));
var import_runtime = require("../../runtime.js");
const pyrightEngineId = "pyright";
const pyrightEngineVersion = "1.1.411";
class PyrightRuntimeAcquirer {
  runtime;
  constructor(options = {}) {
    this.runtime = new import_runtime.PinnedNpmRuntimeAcquirer({
      ...options,
      cacheIdentity: "any",
      engineVersion: pyrightEngineVersion,
      installer: options.installer ?? new import_runtime.NpmRuntimeInstaller(),
      runtimeManifestDirectory: options.runtimeManifestDirectory ?? import_node_path.default.resolve(__dirname, "..", "..", "..", "runtime-pyright")
    });
  }
  acquire() {
    return this.runtime.acquire();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PyrightRuntimeAcquirer,
  pyrightEngineId,
  pyrightEngineVersion
});
