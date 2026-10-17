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
var sweep_state_path_exports = {};
__export(sweep_state_path_exports, {
  reportFile: () => reportFile,
  stateDirectory: () => stateDirectory
});
module.exports = __toCommonJS(sweep_state_path_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
var import_worktree = require("./kernel/worktree.js");
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update((0, import_worktree.canonicalPath)(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path.default.join(stateDirectory(), `${key}.json`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  reportFile,
  stateDirectory
});
