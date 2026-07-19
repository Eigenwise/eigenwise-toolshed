'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function readCursor(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.identity !== 'string') return null;
    return {
      offset: value.offset,
      identity: value.identity,
      anchor: typeof value.anchor === 'string' ? value.anchor : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeCursor(file, cursor) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cursor) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function fileAnchor(file, offset) {
  if (offset === 0) return 'empty';
  const length = Math.min(offset, 128);
  const bytes = Buffer.alloc(length);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, bytes, 0, length, offset - length);
  } finally {
    fs.closeSync(handle);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function classifyPath(value) {
  if (typeof value !== 'string') return 'unknown';
  const pathname = value.split('?', 1)[0].replace(/\/+$/, '') || '/';
  if (pathname === '/v1/messages') return 'messages';
  if (pathname === '/v1/models') return 'models';
  if (pathname === '/health' || pathname === '/healthz') return 'health';
  if (pathname.startsWith('/v1/')) return 'v1_other';
  return 'other';
}

function routeSourceEventId(evidence) {
  return `codex_route_${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}

function routeObservation(entry, options = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) return null;
  const backend = identifier(entry.backend);
  const model = identifier(entry.model);
  if (!backend || !model) return null;

  const pathClass = classifyPath(entry.path);
  const via = identifier(entry.via);
  const effort = typeof entry.effort === 'string' && EFFORTS.has(entry.effort) ? entry.effort : null;
  const sessionId = identifier(entry.sessionId);
  const evidence = {
    at: new Date(entry.at).toISOString(),
    backend,
    model,
    path_class: pathClass,
    via,
    effort,
    session_id: sessionId,
  };
  const attributes = {
    backend,
    effective_model: model,
    path_class: pathClass,
  };
  if (via) attributes.via = via;
  if (effort) attributes.effort = effort;

  const observation = {
    source: 'codex_gateway',
    source_event_id: routeSourceEventId(evidence),
    source_schema: 'route-log-v1',
    observed_at: evidence.at,
    event_name: 'codex_gateway.route',
    attributes,
  };
  if (options.projectId) observation.project_id = options.projectId;
  if (sessionId) observation.session_id = sessionId;
  return observation;
}

function temporalRouteLink(requestId) {
  const safeRequestId = identifier(requestId);
  if (!safeRequestId) return null;
  return {
    relation: 'correlates_with',
    to_kind: 'request',
    to_id: safeRequestId,
    method: 'temporal_inference',
    quality: 'inferred',
  };
}

async function captureCodexRouteLog(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Codex gateway adapter options are required.');
  if (typeof options.logPath !== 'string') throw new TypeError('logPath is required.');
  if (typeof options.cursorPath !== 'string') throw new TypeError('cursorPath is required.');
  if (typeof options.ingest !== 'function') throw new TypeError('ingest is required.');

  let stat;
  try {
    stat = fs.statSync(options.logPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { accepted: 0, duplicates: 0, malformed: 0, offset: 0 };
    throw error;
  }

  const identity = fileIdentity(stat);
  const saved = readCursor(options.cursorPath);
  const continuesSavedFile = saved
    && saved.identity === identity
    && stat.size >= saved.offset
    && saved.anchor === fileAnchor(options.logPath, saved.offset);
  const offset = continuesSavedFile ? saved.offset : 0;
  const bytes = Buffer.alloc(stat.size - offset);
  if (bytes.length > 0) {
    const handle = fs.openSync(options.logPath, 'r');
    try {
      fs.readSync(handle, bytes, 0, bytes.length, offset);
    } finally {
      fs.closeSync(handle);
    }
  }

  let consumed = 0;
  let malformed = 0;
  let accepted = 0;
  let duplicates = 0;
  const seen = new Set();
  while (consumed < bytes.length) {
    const newline = bytes.indexOf(10, consumed);
    if (newline < 0) break;
    const line = bytes.subarray(consumed, newline).toString('utf8').replace(/\r$/, '');
    consumed = newline + 1;
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const observation = routeObservation(entry, options);
    if (!observation) {
      malformed += 1;
      continue;
    }
    if (seen.has(observation.source_event_id)) {
      duplicates += 1;
      continue;
    }
    seen.add(observation.source_event_id);

    if (typeof options.nearestRequest === 'function') {
      const requestId = await options.nearestRequest({
        observed_at: observation.observed_at,
        session_id: observation.session_id || null,
        backend: observation.attributes.backend,
        model: observation.attributes.effective_model,
      });
      const link = temporalRouteLink(requestId);
      if (link) observation.links = [link];
    }
    await options.ingest(observation);
    accepted += 1;
  }

  const nextOffset = offset + consumed;
  writeCursor(options.cursorPath, {
    identity,
    offset: nextOffset,
    anchor: fileAnchor(options.logPath, nextOffset),
  });
  return { accepted, duplicates, malformed, offset: nextOffset };
}

module.exports = {
  captureCodexRouteLog,
  classifyPath,
  readCursor,
  routeObservation,
  temporalRouteLink,
};
