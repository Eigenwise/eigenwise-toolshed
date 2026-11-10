'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { writeFileAtomically } = require('./atomic-file.js');
const { ANTHROPIC_UPSTREAM, STATE, gatewayClientModelId } = require('./runtime.js');

const CACHE_PATH = path.join(STATE, 'anthropic-models.json');
const TTL_MS = 60 * 60 * 1000;
const ALLOWED_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'anthropic-workspace-id', 'user-agent']);

function catalogHeaders(incoming) {
  return { 'anthropic-version': '2023-06-01', ...Object.fromEntries(Object.entries(incoming)
    .filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value])) };
}

function validCatalogRows(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid catalog data');
  return rows.filter((row) => /^claude-[a-z0-9._-]+$/.test(row?.id)
    && typeof row.display_name === 'string');
}

function readAnthropicCatalog() {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return { ...saved, data: validCatalogRows(saved.data) };
  } catch { return { data: [], updatedAt: 0 }; }
}

function requestCatalogPage(url, headers, lookup) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, { headers, lookup }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`upstream HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) request.destroy(new Error('catalog too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid catalog JSON')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('catalog timeout')), 5000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
  });
}

async function fetchAnthropicCatalog(headers, lookup) {
  const rows = [];
  const url = new URL('/v1/models?limit=1000', ANTHROPIC_UPSTREAM);
  for (let page = 0; page < 10; page++) {
    const result = await requestCatalogPage(url, headers, lookup);
    rows.push(...validCatalogRows(result.data));
    if (!result.has_more) return rows;
    if (typeof result.last_id !== 'string' || result.last_id === url.searchParams.get('after_id')) break;
    url.searchParams.set('after_id', result.last_id);
  }
  throw new Error('catalog pagination limit');
}

function writeCatalog(saved) {
  fs.mkdirSync(STATE, { recursive: true });
  writeFileAtomically(CACHE_PATH, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
}

function createAnthropicCatalog({ lookup } = {}) {
  let inFlight = null;
  async function refresh(headers, cached) {
    try {
      const data = await fetchAnthropicCatalog(headers, lookup);
      const saved = { data, updatedAt: Date.now(), error: null };
      writeCatalog(saved);
      return saved;
    } catch (error) {
      const saved = { ...cached, error: error.message, attemptedAt: Date.now() };
      try { writeCatalog(saved); } catch {}
      return saved;
    }
  }
  return async function anthropicModels(incoming = {}) {
    const cached = readAnthropicCatalog();
    if (Date.now() - cached.updatedAt < TTL_MS) return cached.data;
    const headers = catalogHeaders(incoming);
    if (!headers.authorization && !headers['x-api-key']) return cached.data;
    if (!inFlight) inFlight = refresh(headers, cached).finally(() => { inFlight = null; });
    if (cached.data.length) return cached.data;
    return (await inFlight).data;
  };
}

function advertisedAnthropicRows(rows) {
  return rows.map((row) => ({ ...row, id: gatewayClientModelId(row.id) }));
}

function anthropicCatalogReport() {
  const catalog = readAnthropicCatalog();
  const age = catalog.updatedAt ? `${Math.max(0, Math.floor((Date.now() - catalog.updatedAt) / 1000))}s old` : 'not cached';
  const failure = catalog.error ? `; ${catalog.error}; serving ${catalog.data.length ? 'cached Anthropic rows' : 'Codex/Grok only'}` : '';
  return `Anthropic catalog: ${age}; ${catalog.data.length} models${failure}`;
}

module.exports = { advertisedAnthropicRows, anthropicCatalogReport, catalogHeaders, createAnthropicCatalog, readAnthropicCatalog };
