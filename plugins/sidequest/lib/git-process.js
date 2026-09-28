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
var git_process_exports = {};
__export(git_process_exports, {
  GIT_OUTPUT_MAX_BUFFER: () => GIT_OUTPUT_MAX_BUFFER,
  execFileSync: () => execFileSync,
  execFileText: () => execFileText
});
module.exports = __toCommonJS(git_process_exports);
var import_node_child_process = __toESM(require("node:child_process"));
var import_node_util = require("node:util");
const GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;
const execFileCallback = (0, import_node_util.promisify)(import_node_child_process.default.execFile);
function execFileSync(file, args, options = {}) {
  return import_node_child_process.default.execFileSync(file, args, { maxBuffer: GIT_OUTPUT_MAX_BUFFER, windowsHide: true, ...options });
}
async function execFileText(file, args, options = {}) {
  const { stdout } = await execFileCallback(file, args, { maxBuffer: GIT_OUTPUT_MAX_BUFFER, windowsHide: true, ...options, encoding: "utf8" });
  return stdout;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GIT_OUTPUT_MAX_BUFFER,
  execFileSync,
  execFileText
});
