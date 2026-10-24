'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { inspectCapabilities, unconfirmed, readiness, isReservedModel, pickerId } = require('./antigravity-contract.js');

// Read-only metadata probes are independent of generation and bounded by elapsed
// time and bytes. No version check, refresh, project lookup or state write occurs.
async function readBoundedBody(response, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error('Antigravity response exceeds its byte budget');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function openResponse(url, { body = null, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, resolve);
    request.once('error', reject);
    request.end(body);
  });
}

async function fetchCapabilities({ port, signal, timeoutMs = 2500, now = Date.now } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await openResponse(`http://127.0.0.1:${port}/v1/models?include_capabilities=true`, { signal: combined, agent: false });
    const body = await readBoundedBody(response, 256 * 1024);
    if (response.statusCode !== 200) return unconfirmed('transport-error');
    return parseCapabilities(body, now());
  } catch { return unconfirmed('transport-error'); }
}

function parseCapabilities(body, observedAt) {
  try { return inspectCapabilities(JSON.parse(body.toString()), observedAt); }
  catch { return unconfirmed('malformed'); }
}

function persistedEnvelope(snapshot) {
  return { data: snapshot.models.map((id) => ({ id })), capabilities: { schema_version: 1, providers: { antigravity: snapshot.provider } } };
}

function decodeObservation(stored) {
  if (stored.schemaVersion !== 1 || !Number.isFinite(stored.observedAt)) return null;
  const snapshot = inspectCapabilities(stored.envelope, stored.observedAt);
  return snapshot.authoritative ? snapshot : null;
}

function readObservation(file) {
  if (!file) return null;
  try { return decodeObservation(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return null; }
}

function persistObservation(file, snapshot) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomically(file, JSON.stringify({ schemaVersion: 1, source: 'serving-http', observedAt: snapshot.observedAt,
      envelope: persistedEnvelope(snapshot) }) + '\n', { mode: 0o600 });
  } catch { /* Observation persistence is advisory, never permission to fabricate support. */ }
}

function observedSnapshot(snapshot, previous, attemptedAt) {
  const remembered = snapshot.authoritative ? snapshot : previous;
  return { ...snapshot, models: remembered?.models || [], observedAt: remembered?.observedAt ?? null,
    attemptedAt, source: snapshot.authoritative ? 'serving-http' : 'unconfirmed', readiness: readiness(snapshot) };
}

function shouldQuery(ids, previous, force) {
  return force || previous !== null || ids.some(isReservedModel);
}

function createDiscoveryTracker({ port, file = null, now = Date.now, probe = () => fetchCapabilities({ port, now }) } = {}) {
  let previous = readObservation(file);
  let current = observedSnapshot(unconfirmed('unsupported'), previous, null);
  return {
    current: () => current,
    async observe(ids, { force = false } = {}) {
      if (!shouldQuery(ids, previous, force)) return current;
      const snapshot = await probe();
      current = observedSnapshot(snapshot, previous, now());
      if (snapshot.authoritative) {
        previous = snapshot;
        persistObservation(file, snapshot);
      }
      return current;
    },
  };
}

function agyRow(row) { return row?.provider === 'antigravity' || isReservedModel(row?.id); }

function admittedRows(rows, snapshot) {
  const ids = new Set(snapshot.models.map(pickerId));
  return rows.filter((row) => !agyRow(row) || ids.has(pickerId(row.id)));
}

function readinessProviders(catalog, snapshot) {
  const providers = { ...catalog.providers };
  if (catalog.models.some(agyRow)) providers.antigravity = snapshot.readiness || readiness(snapshot);
  else delete providers.antigravity;
  return { ...catalog, providers };
}

function retainUnconfirmedRows(existing, catalog) {
  const present = new Set(catalog.models.map((row) => row.id));
  const retained = existing.models.filter((row) => agyRow(row) && !present.has(row.id));
  return { ...catalog, models: [...catalog.models, ...retained] };
}

function reconcileCatalog(existing, catalog, snapshot) {
  if (!snapshot) return { existing, catalog };
  const prior = existing?.schemaVersion === 4 && Array.isArray(existing.models) ? existing : { models: [] };
  if (!snapshot.authoritative) return { existing, catalog: readinessProviders(retainUnconfirmedRows(prior, catalog), snapshot) };
  const filtered = { ...prior, models: admittedRows(prior.models, snapshot) };
  return { existing: filtered, catalog: readinessProviders({ ...catalog, models: admittedRows(catalog.models, snapshot) }, snapshot) };
}

module.exports = { fetchCapabilities, readBoundedBody, openResponse, createDiscoveryTracker, reconcileCatalog,
  readObservation, observedSnapshot, shouldQuery };
