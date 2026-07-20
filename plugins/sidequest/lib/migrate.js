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
var migrate_exports = {};
__export(migrate_exports, {
  migrateIfNeeded: () => migrateIfNeeded
});
module.exports = __toCommonJS(migrate_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_db = require("./db.js");
const GLOBAL_FILES = [
  ["model-prefs.json", "model-prefs"],
  ["notifications.json", "notifications"],
  ["notify-prefs.json", "notify-prefs"],
  ["workers.json", "workers"]
];
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readJson(file) {
  return JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
}
function readRecord(file) {
  const value = readJson(file);
  if (!isRecord(value)) throw new TypeError(`Expected a JSON object in ${file}.`);
  return value;
}
function jsonFiles(dir) {
  if (!import_node_fs.default.existsSync(dir)) return [];
  return import_node_fs.default.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && import_node_path.default.extname(entry.name) === ".json").map((entry) => import_node_path.default.join(dir, entry.name));
}
function collectProject(rows, projectsDir, slug) {
  const dir = import_node_path.default.join(projectsDir, slug);
  const metaFile = import_node_path.default.join(dir, "meta.json");
  if (import_node_fs.default.existsSync(metaFile)) {
    rows.projects.push({ slug, data: readJson(metaFile) });
  }
  for (const file of jsonFiles(import_node_path.default.join(dir, "tickets"))) {
    const ticket = readRecord(file);
    const claim = isRecord(ticket.claim) ? ticket.claim : null;
    rows.tickets.push({
      id: ticket.id,
      project: slug,
      ref: ticket.ref ? ticket.ref : null,
      status: ticket.status ? ticket.status : null,
      archived: ticket.archived ? 1 : 0,
      ord: Number(ticket.order) || 0,
      claim_by: claim?.by ? claim.by : null,
      data: ticket
    });
  }
  for (const file of jsonFiles(import_node_path.default.join(dir, "stories"))) {
    const story = readRecord(file);
    rows.stories.push({ id: story.id, project: slug, data: story });
  }
}
function collectMigration(homeRoot) {
  const rows = { projects: [], tickets: [], stories: [], globals: [] };
  const projectsDir = import_node_path.default.join(homeRoot, "projects");
  if (import_node_fs.default.existsSync(projectsDir)) {
    for (const entry of import_node_fs.default.readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) collectProject(rows, projectsDir, entry.name);
    }
  }
  for (const [filename, key] of GLOBAL_FILES) {
    const file = import_node_path.default.join(projectsDir, filename);
    if (import_node_fs.default.existsSync(file)) rows.globals.push({ key, data: readJson(file) });
  }
  const serverFile = import_node_path.default.join(homeRoot, "server.json");
  if (import_node_fs.default.existsSync(serverFile)) rows.globals.push({ key: "server-info", data: readJson(serverFile) });
  return rows;
}
function migrateIfNeeded(database, homeRoot) {
  if ((0, import_db.getRow)(database, "meta", "json_migrated") === "1") return;
  const rows = collectMigration(homeRoot);
  (0, import_db.txn)(database, () => {
    for (const row of rows.projects) (0, import_db.putRow)(database, "projects", row);
    for (const row of rows.tickets) (0, import_db.putRow)(database, "tickets", row);
    for (const row of rows.stories) (0, import_db.putRow)(database, "stories", row);
    for (const row of rows.globals) (0, import_db.putRow)(database, "globals", row);
    (0, import_db.putRow)(database, "meta", { key: "json_migrated", value: "1" });
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  migrateIfNeeded
});
