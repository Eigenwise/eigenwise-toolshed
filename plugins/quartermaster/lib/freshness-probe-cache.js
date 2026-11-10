'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stateRoot } = require('./paths.js');

const MINUTE_MS = 60_000;

function readEntries(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    return entries && typeof entries === 'object' ? entries : {};
  } catch {
    return {};
  }
}

function cacheAge(entry, now) {
  if (!Number.isFinite(entry?.checkedAt)) return 'unknown age';
  return `${Math.max(0, Math.floor((now - entry.checkedAt) / MINUTE_MS))}m`;
}

function currentEntry(entry, now, maximumAge) {
  const elapsed = now - entry?.checkedAt;
  return elapsed >= 0 && elapsed < maximumAge;
}

function comparisonAge(environment) {
  const hours = Number(environment.QUARTERMASTER_FRESHNESS_CACHE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 60 * MINUTE_MS;
}

function writeEntries(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entries));
  fs.renameSync(temporary, file);
}

function createProbeCache({ environment = process.env, now = Date.now(), refresh = false } = {}) {
  const file = path.join(stateRoot(environment), 'freshness-probes.json');
  const entries = readEntries(file);
  const ages = new Map();
  function readProbe(name, identity, maximumAge, probe, fallback) {
    const key = crypto.createHash('sha256').update(JSON.stringify([name, identity])).digest('hex');
    let entry = entries[key];
    if (entry?.checkedAt > now) entry = undefined;
    if (refresh && !currentEntry(entry, now, maximumAge)) {
      entry = { checkedAt: now, value: probe() };
      entries[key] = entry;
      writeEntries(file, entries);
    }
    ages.set(name, cacheAge(entry, now));
    return entry ? entry.value : fallback();
  }
  return { readProbe, ages, now };
}

function gatewayUnhealthy(check) {
  return !check.available || [check.auth, check.proxy, check.shim].includes(false);
}

function cachedGatewayCheck(cache, gateway, checkGateway) {
  const check = cache.readProbe('gateway', gateway, 10 * MINUTE_MS, () => checkGateway(gateway), () => ({ available: false, state: 'unknown' }));
  const age = cache.ages.get('gateway');
  const state = check.available ? 'unhealthy' : (check.state || 'unknown');
  if (gatewayUnhealthy(check)) return { checking: `gateway: checking (last known ${state} ${age} ago)` };
  return { ...check, cachedAge: age };
}

module.exports = { MINUTE_MS, cacheAge, cachedGatewayCheck, comparisonAge, createProbeCache, currentEntry, gatewayUnhealthy };
