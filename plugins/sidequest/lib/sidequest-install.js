"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sidequest_install_exports = {};
__export(sidequest_install_exports, {
  selectSidequestRegistry: () => selectSidequestRegistry
});
module.exports = __toCommonJS(sidequest_install_exports);
function selectSidequestRegistry(registry, pluginRoot, claudeHome) {
  const fs = require("node:fs");
  const path = require("node:path");
  const officialId = "sidequest@eigenwise-toolshed";
  const canonical = (value) => {
    if (typeof value !== "string" || !value || !path.isAbsolute(value)) return null;
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync(resolved);
    } catch (_) {
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const root = canonical(pluginRoot);
  const cache = canonical(path.join(claudeHome, "plugins", "cache"));
  const plugins = registry?.plugins && typeof registry.plugins === "object" ? registry.plugins : {};
  const keys = Object.keys(plugins).filter((key) => /^sidequest@[^/\\@]+$/.test(key) && Array.isArray(plugins[key]));
  const relative = root && cache ? path.relative(cache, root) : "";
  const parts = relative.split(path.sep);
  const cacheIdentity = parts.length === 3 && parts[0] !== ".." && parts[1] === "sidequest" && !path.isAbsolute(relative);
  let pluginId = officialId;
  let sourceCacheFamily = null;
  if (cacheIdentity) {
    pluginId = `sidequest@${parts[0]}`;
  } else if (root) {
    if (!fs.existsSync(root)) return { pluginId: null, installs: [] };
    const readJson = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (_) {
        return null;
      }
    };
    const known = readJson(path.join(claudeHome, "plugins", "known_marketplaces.json"));
    const within = (directory, value) => value === directory || value.startsWith(directory + path.sep);
    const owners = [];
    for (const [name, metadata] of Object.entries(known && typeof known === "object" ? known : {})) {
      const id = `sidequest@${name}`;
      if (id === officialId || !/^sidequest@[^/\\@]+$/.test(id) || metadata?.source?.source !== "directory") continue;
      const directory = canonical(metadata.source.path);
      if (!directory) continue;
      const catalog = readJson(path.join(directory, ".claude-plugin", "marketplace.json"));
      const declarations = Array.isArray(catalog?.plugins) ? catalog.plugins.filter((entry) => entry?.name === "sidequest" && typeof entry.source === "string") : [];
      const matching = declarations.filter((entry) => canonical(path.resolve(directory, entry.source)) === root);
      if (!within(directory, root) && !matching.length) continue;
      const valid = canonical(metadata.installLocation) === directory && catalog?.name === name && matching.length === 1 && matching[0].source.startsWith("./") && !matching[0].source.split(/[\\/]/).includes("..") && within(directory, root);
      owners.push({ pluginId: id, valid, family: canonical(path.join(claudeHome, "plugins", "cache", name, "sidequest")) });
    }
    if (owners.length > 1) return { pluginId: null, installs: [] };
    if (owners.length === 1) {
      const owner = owners[0];
      if (!owner.valid) return { pluginId: owner.pluginId, installs: [] };
      pluginId = owner.pluginId;
      sourceCacheFamily = owner.family;
    } else {
      let directory = root;
      for (; ; ) {
        const catalog = readJson(path.join(directory, ".claude-plugin", "marketplace.json"));
        const id = typeof catalog?.name === "string" ? `sidequest@${catalog.name}` : "";
        if (id !== officialId && /^sidequest@[^/\\@]+$/.test(id)) return { pluginId: id, installs: [] };
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      const exact = keys.filter((key) => plugins[key].some((install) => canonical(install?.installPath) === root));
      if (exact.length > 1) return { pluginId: null, installs: [] };
      if (exact.length === 1) pluginId = exact[0];
    }
  }
  const installs = Array.isArray(plugins[pluginId]) ? plugins[pluginId] : [];
  if (pluginId === officialId) return { pluginId, installs };
  return {
    pluginId,
    installs: installs.filter((install) => {
      if (!install || !["local", "project", "user"].includes(install.scope)) return false;
      const candidate = canonical(install.installPath);
      if (!root || !candidate) return false;
      if (sourceCacheFamily) return candidate === root || path.dirname(candidate) === sourceCacheFamily;
      return cacheIdentity ? path.dirname(candidate) === path.dirname(root) : candidate === root;
    })
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  selectSidequestRegistry
});
