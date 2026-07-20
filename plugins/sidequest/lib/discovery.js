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
var discovery_exports = {};
__export(discovery_exports, {
  CATALOG_SOURCES: () => CATALOG_SOURCES,
  discoverExternalModels: () => discoverExternalModels
});
module.exports = __toCommonJS(discovery_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CATALOG_SOURCES = [
  { source: "codex-gateway", relPath: import_node_path.default.join("codex-gateway", "catalog.json"), schemas: /* @__PURE__ */ new Set([2, 3]) }
];
function discoveryRoots() {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override?.trim()) {
    return override.split(",").map((value) => value.trim()).filter(Boolean).map((value) => import_node_path.default.resolve(value));
  }
  return [import_node_path.default.join(import_node_os.default.homedir(), ".claude")];
}
function readJsonSafe(file) {
  try {
    return JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function isRecord(value) {
  return value !== null && typeof value === "object";
}
function catalogModels(data, schemas) {
  if (!isRecord(data)) return [];
  const catalog = data;
  const schema = catalog.schemaVersion ?? catalog.schema;
  if (typeof schema !== "number" || !schemas.has(schema) || !Array.isArray(catalog.models)) return [];
  return catalog.models;
}
function validateEntry(raw, source) {
  if (!isRecord(raw)) return null;
  const model = raw;
  const slug = typeof model.slug === "string" ? model.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const label = typeof model.label === "string" && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, source };
}
function discoverExternalModels() {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const models = catalogModels(readJsonSafe(import_node_path.default.join(root, relPath)), schemas);
      for (const raw of models) {
        const entry = validateEntry(raw, source);
        const key = entry && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CATALOG_SOURCES,
  discoverExternalModels
});
