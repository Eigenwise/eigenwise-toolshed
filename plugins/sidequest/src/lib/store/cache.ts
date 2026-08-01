'use strict';

function createCache({ database, db, fs }: any) {
interface StoreCache {
  dataVersion: number;
  metadata: Map<string, any>;
  projectCategories: Map<string, any[]>;
  routingProfiles: Map<string, any>;
  routingProfileEntries: Map<string, any[]>;
  projectRoutingProfiles: Map<string, any>;
  routingProfileSettings: any | undefined;
  routingFallback: any | undefined;
  snapshots: Map<string, any>;
}

const storeCacheByDatabase = new WeakMap<object, StoreCache>();

function sqliteDataVersion(handle: any): number {
  const row = handle.prepare('PRAGMA data_version').get();
  return Number(row && row.data_version) || 0;
}

function newStoreCache(dataVersion: number): StoreCache {
  return {
    dataVersion,
    metadata: new Map<string, any>(),
    projectCategories: new Map<string, any[]>(),
    routingProfiles: new Map<string, any>(),
    routingProfileEntries: new Map<string, any[]>(),
    projectRoutingProfiles: new Map<string, any>(),
    routingProfileSettings: undefined,
    routingFallback: undefined,
    snapshots: new Map<string, any>(),
  };
}

function residentCache(): StoreCache {
  const handle = database();
  const dataVersion = sqliteDataVersion(handle);
  let cache = storeCacheByDatabase.get(handle);
  if (!cache || cache.dataVersion !== dataVersion) {
    cache = newStoreCache(dataVersion);
    storeCacheByDatabase.set(handle, cache);
  }
  return cache;
}

function invalidateStoreCaches(): void {
  const handle = database();
  storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
}

function putCachedRow(handle: any, table: any, row: any): any {
  const result = db.putRow(handle, table, row);
  invalidateStoreCaches();
  return result;
}

function deleteCachedRow(handle: any, table: any, key: any): boolean {
  const deleted = db.deleteRow(handle, table, key);
  if (deleted) invalidateStoreCaches();
  return deleted;
}

function cloneCached<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function ensureDir(dir?: any) {
  fs.mkdirSync(dir, { recursive: true });
}


  return { sqliteDataVersion, newStoreCache, residentCache, invalidateStoreCaches, putCachedRow, deleteCachedRow, cloneCached, ensureDir };
}

module.exports = { createCache };
