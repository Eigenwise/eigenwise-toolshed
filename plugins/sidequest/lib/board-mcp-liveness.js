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
var board_mcp_liveness_exports = {};
__export(board_mcp_liveness_exports, {
  boardMcpMarkerDirectory: () => boardMcpMarkerDirectory,
  clearBoardMcpLiveness: () => clearBoardMcpLiveness,
  observeBoardMcp: () => observeBoardMcp,
  writeBoardMcpLiveness: () => writeBoardMcpLiveness
});
module.exports = __toCommonJS(board_mcp_liveness_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
var import_worktree = require("./kernel/worktree.js");
const MARKER_PREFIX = "board-mcp-";
const MARKER_SUFFIX = ".json";
function boardMcpMarkerDirectory() {
  const home = process.env.SIDEQUEST_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path.default.join(home, "tmp", "state");
}
function ownMarkerFile() {
  return import_node_path.default.join(boardMcpMarkerDirectory(), `${MARKER_PREFIX}pid-${process.pid}${MARKER_SUFFIX}`);
}
function writeBoardMcpLiveness(sessionId, project) {
  const file = ownMarkerFile();
  try {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
    import_node_fs.default.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, project: project ? (0, import_worktree.canonicalPath)(project) : "" }));
  } catch (_) {
  }
}
function clearBoardMcpLiveness() {
  try {
    import_node_fs.default.rmSync(ownMarkerFile(), { force: true });
  } catch (_) {
  }
}
function stringProperty(value, key) {
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}
function legacySessionId(name) {
  return decodeURIComponent(name.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
}
function readMarker(directory, name) {
  const file = import_node_path.default.join(directory, name);
  try {
    const value = JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || !Number.isInteger(Reflect.get(value, "pid"))) return [];
    const sessionId = stringProperty(value, "sessionId") ?? legacySessionId(name);
    return [{ pid: Number(Reflect.get(value, "pid")), sessionId, project: stringProperty(value, "project") ?? "", file }];
  } catch (_) {
    return [];
  }
}
function processAlive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function observeMarkers(markers, sessionId, projectKey, directory) {
  const candidates = markers.filter((marker) => marker.sessionId === sessionId || projectKey !== "" && marker.project === projectKey);
  const live = candidates.find((marker) => processAlive(marker.pid));
  if (live) return { state: live.sessionId === sessionId ? "live" : "rotated", marker: live };
  const exited = candidates.find((marker) => marker.sessionId === sessionId) || candidates[0];
  return exited ? { state: "exited", marker: exited } : { state: "absent", directory };
}
function observeBoardMcp(sessionId, project) {
  const directory = boardMcpMarkerDirectory();
  let names;
  try {
    names = import_node_fs.default.readdirSync(directory).filter((name) => name.startsWith(MARKER_PREFIX) && name.endsWith(MARKER_SUFFIX));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    return code === "ENOENT" ? { state: "absent", directory } : { state: "unreadable", directory, detail: String(error) };
  }
  const markers = names.flatMap((name) => readMarker(directory, name));
  return observeMarkers(markers, sessionId, project ? (0, import_worktree.canonicalPath)(project) : "", directory);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  boardMcpMarkerDirectory,
  clearBoardMcpLiveness,
  observeBoardMcp,
  writeBoardMcpLiveness
});
