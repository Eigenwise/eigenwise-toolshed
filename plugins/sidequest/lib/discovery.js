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
  CATALOG_STALE_MS: () => CATALOG_STALE_MS,
  configuredExternalModelProvider: () => configuredExternalModelProvider,
  discoverExternalModels: () => discoverExternalModels,
  providerReadiness: () => providerReadiness
});
module.exports = __toCommonJS(discovery_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CATALOG_SOURCES = [
  { source: "model-gateway", relPath: import_node_path.default.join("model-gateway", "catalog.json"), schemas: /* @__PURE__ */ new Set([2, 3, 4]) }
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
function versionParts(version) {
  const match = typeof version === "string" && version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function isNewerVersion(candidate, current) {
  for (const index of [0, 1, 2]) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}
function newestGatewayCatalogCommand() {
  if (process.env.SIDEQUEST_DISCOVERY_DIRS?.trim()) return null;
  const registry = readJsonSafe(import_node_path.default.join(import_node_os.default.homedir(), ".claude", "plugins", "installed_plugins.json"));
  if (!isRecord(registry) || !isRecord(registry.plugins)) return null;
  const entries = registry.plugins["model-gateway@eigenwise-toolshed"];
  if (!Array.isArray(entries)) return null;
  let newest = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
    const version = versionParts(entry.version);
    const command = import_node_path.default.join(entry.installPath, "bin", "model-gateway.js");
    if (!version || !import_node_fs.default.existsSync(command) || newest && !isNewerVersion(version, newest.version)) continue;
    newest = { command, version };
  }
  return newest?.command ?? null;
}
function refreshGatewayCatalog() {
  const command = newestGatewayCatalogCommand();
  if (!command) return null;
  try {
    const result = (0, import_node_child_process.spawnSync)(process.execPath, [command, "catalog", "--refresh", "--json"], {
      encoding: "utf8",
      timeout: 5e3,
      windowsHide: true
    });
    if (result.status !== 0) return null;
    const catalog = JSON.parse(result.stdout);
    return isRecord(catalog) ? catalog : null;
  } catch {
    return null;
  }
}
const CATALOG_STALE_MS = 5 * 60 * 1e3;
function usableCatalog(data, schemas) {
  if (!isRecord(data)) return null;
  const catalog = data;
  const schema = catalog.schemaVersion ?? catalog.schema;
  const updatedAt = typeof catalog.updatedAt === "string" ? Date.parse(catalog.updatedAt) : Number.NaN;
  const age = Date.now() - updatedAt;
  return typeof schema === "number" && schemas.has(schema) && Array.isArray(catalog.models) && Number.isFinite(updatedAt) && age >= 0 && age <= CATALOG_STALE_MS ? catalog : null;
}
function catalogSchema(catalog) {
  return catalog.schemaVersion ?? catalog.schema;
}
function validateReadiness(raw) {
  if (!isRecord(raw) || typeof raw.ready !== "boolean") return null;
  const state = typeof raw.state === "string" ? raw.state.trim() : "";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  return state && message ? { ready: raw.ready, state, message } : null;
}
function catalogProviderReadiness(catalog, provider) {
  const schema = catalogSchema(catalog);
  const readiness = schema >= 4 ? isRecord(catalog.providers) && validateReadiness(catalog.providers[provider]) : provider === "codex" && validateReadiness(catalog.codexReadiness);
  return readiness ? { provider, ...readiness } : null;
}
function providerReadiness(provider) {
  for (const root of discoveryRoots()) {
    for (const { relPath, schemas } of CATALOG_SOURCES) {
      const storedCatalog = readJsonSafe(import_node_path.default.join(root, relPath));
      let catalog = usableCatalog(storedCatalog, schemas);
      let readiness = catalog && catalogProviderReadiness(catalog, provider);
      if (provider === "codex" && isRecord(storedCatalog) && (!catalog || !readiness?.ready)) {
        const refreshedCatalog = usableCatalog(refreshGatewayCatalog(), schemas);
        if (refreshedCatalog) {
          catalog = refreshedCatalog;
          readiness = catalogProviderReadiness(catalog, provider);
        }
      }
      if (readiness) return readiness;
    }
  }
  return null;
}
function validateEntry(raw, source, schema) {
  if (!isRecord(raw)) return null;
  const model = raw;
  const slug = typeof model.slug === "string" ? model.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const provider = schema >= 4 ? typeof model.provider === "string" && model.provider === model.provider.toLowerCase() && SLUG_RE.test(model.provider) ? model.provider : "" : "codex";
  if (!provider) return null;
  const label = typeof model.label === "string" && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, provider, source };
}
function configuredExternalModelProvider(slug) {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalizedSlug)) return null;
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = usableCatalog(readJsonSafe(import_node_path.default.join(root, relPath)), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        if (entry?.slug === normalizedSlug) return entry.provider;
      }
    }
  }
  return null;
}
function discoverExternalModels() {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = usableCatalog(readJsonSafe(import_node_path.default.join(root, relPath)), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        const readiness = entry && catalogProviderReadiness(catalog, entry.provider);
        const key = entry && readiness?.ready && `${entry.source}:${entry.slug}`;
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
  CATALOG_STALE_MS,
  configuredExternalModelProvider,
  discoverExternalModels,
  providerReadiness
});
