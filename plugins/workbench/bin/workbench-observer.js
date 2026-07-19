#!/usr/bin/env node
'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { flushOutbox } = require('../lib/observability/outbox.js');
const { RESOLVED_VIEWS } = require('../lib/observability/schema.js');
const { otlpToObservations } = require('../lib/observability/otlp.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const OTLP_SIGNALS = Object.freeze({ '/v1/logs': 'logs', '/v1/traces': 'traces', '/v1/metrics': 'metrics' });

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`Observer host must be loopback, received ${host}.`);
  return host;
}

function jsonResponse(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function requestError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readJson(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      reject(requestError(415, 'json_required'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        reject(requestError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(requestError(400, 'invalid_json'));
      }
    });
    request.on('error', () => {
      if (settled) return;
      settled = true;
      reject(requestError(400, 'request_failed'));
    });
  });
}

function createObserver(options = {}) {
  const host = assertLoopbackHost(options.host || '127.0.0.1');
  const port = Number(options.port === undefined ? 14319 : options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid observer port: ${options.port}`);
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes) || 1024 * 1024);
  const ownsStore = !options.store;
  const store = options.store || openObservabilityStore(options.databaseFile || defaultDatabaseFile());
  const outboxEndpoint = options.outboxEndpoint || 'http://127.0.0.1:14318/v1/logs';

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port || 80}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        const [outbox] = store.queryView('outbox_health', { limit: 1 });
        jsonResponse(response, 200, { ok: true, outbox });
        return;
      }

      if (request.method === 'POST' && ['/v1/observations', '/v1/ingest'].includes(url.pathname)) {
        const body = await readJson(request, maxBodyBytes);
        if (Array.isArray(body) && body.length === 0) throw requestError(400, 'empty_batch');
        const results = Array.isArray(body) ? store.ingestBatch(body) : [store.ingest(body)];
        const rejected = results.some((result) => !result.accepted);
        jsonResponse(response, rejected ? 422 : 200, {
          committed: results.every((result) => result.committed),
          results,
        });
        return;
      }

      if (request.method === 'POST' && OTLP_SIGNALS[url.pathname]) {
        const body = await readJson(request, maxBodyBytes);
        const observations = otlpToObservations(OTLP_SIGNALS[url.pathname], body, { projectId: options.projectId });
        if (observations.length === 0) {
          jsonResponse(response, 200, { committed: true, results: [] });
          return;
        }
        const results = store.ingestBatch(observations);
        const rejected = results.some((result) => !result.accepted);
        jsonResponse(response, rejected ? 422 : 200, {
          committed: results.every((result) => result.committed),
          results,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/v1/views/')) {
        const view = decodeURIComponent(url.pathname.slice('/v1/views/'.length));
        if (!RESOLVED_VIEWS.includes(view)) throw requestError(404, 'view_not_found');
        const limit = Number(url.searchParams.get('limit') || 1000);
        jsonResponse(response, 200, { view, rows: store.queryView(view, { limit }) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/outbox/flush') {
        const result = await flushOutbox(store, {
          endpoint: outboxEndpoint,
          fetch: options.fetch,
          maxAttempts: options.maxOutboxAttempts,
        });
        jsonResponse(response, 200, result);
        return;
      }

      throw requestError(404, 'not_found');
    } catch (error) {
      const statusCode = Number(error && error.statusCode) || 500;
      const code = error && error.code && statusCode < 500 ? error.code : 'observer_error';
      if (!response.headersSent && !response.destroyed) jsonResponse(response, statusCode, { error: code });
    }
  });

  let started = false;
  return {
    host,
    port,
    server,
    store,
    async start() {
      if (started) return server.address();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      started = true;
      return server.address();
    },
    async close() {
      if (started) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        started = false;
      }
      if (ownsStore) store.close();
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--db' && next) { options.databaseFile = next; index += 1; continue; }
    if (argument === '--host' && next) { options.host = next; index += 1; continue; }
    if (argument === '--port' && next) { options.port = Number(next); index += 1; continue; }
    if (argument === '--outbox-endpoint' && next) { options.outboxEndpoint = next; index += 1; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function defaultDatabaseFile() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Eigenwise', 'Workbench', 'observability.db');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.databaseFile) options.databaseFile = defaultDatabaseFile();
  const observer = createObserver(options);
  const address = await observer.start();
  process.stdout.write(`Workbench observer listening on ${address.address}:${address.port}\n`);
  const stop = async () => {
    await observer.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Workbench observer failed to start.\n');
    process.exitCode = 1;
  });
}

module.exports = {
  assertLoopbackHost,
  createObserver,
  defaultDatabaseFile,
  parseArgs,
};
