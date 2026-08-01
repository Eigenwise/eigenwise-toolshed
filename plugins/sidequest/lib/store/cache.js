"use strict";
function createCache({ database, db, fs }) {
  const storeCacheByDatabase = /* @__PURE__ */ new WeakMap();
  function sqliteDataVersion(handle) {
    const row = handle.prepare("PRAGMA data_version").get();
    return Number(row && row.data_version) || 0;
  }
  function newStoreCache(dataVersion) {
    return {
      dataVersion,
      metadata: /* @__PURE__ */ new Map(),
      projectCategories: /* @__PURE__ */ new Map(),
      routingProfiles: /* @__PURE__ */ new Map(),
      routingProfileEntries: /* @__PURE__ */ new Map(),
      projectRoutingProfiles: /* @__PURE__ */ new Map(),
      routingProfileSettings: void 0,
      routingFallback: void 0,
      snapshots: /* @__PURE__ */ new Map()
    };
  }
  function residentCache() {
    const handle = database();
    const dataVersion = sqliteDataVersion(handle);
    let cache = storeCacheByDatabase.get(handle);
    if (!cache || cache.dataVersion !== dataVersion) {
      cache = newStoreCache(dataVersion);
      storeCacheByDatabase.set(handle, cache);
    }
    return cache;
  }
  function invalidateStoreCaches() {
    const handle = database();
    storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
  }
  function putCachedRow(handle, table, row) {
    const result = db.putRow(handle, table, row);
    invalidateStoreCaches();
    return result;
  }
  function deleteCachedRow(handle, table, key) {
    const deleted = db.deleteRow(handle, table, key);
    if (deleted) invalidateStoreCaches();
    return deleted;
  }
  function cloneCached(value) {
    return value == null ? value : structuredClone(value);
  }
  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { sqliteDataVersion, newStoreCache, residentCache, invalidateStoreCaches, putCachedRow, deleteCachedRow, cloneCached, ensureDir };
}
module.exports = { createCache };
