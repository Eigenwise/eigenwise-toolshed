#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { DEFAULT_RETENTION_DAYS, openObservabilityStore } = require('../lib/observability/store.js');
const { DEFAULT_DRAIN_BUDGET_MS, drainHookSpool } = require('../lib/observability/hook-spool.js');
const { defaultSpoolPath } = require('../hooks/observability.js');
const { createOutboxDrainer } = require('../lib/observability/outbox.js');
const { RESOLVED_VIEWS } = require('../lib/observability/schema.js');
const { otlpToObservations } = require('../lib/observability/otlp.js');
const {
  DEFAULT_SINK,
  defaultConfigPath,
  readObservabilityConfig,
  resolveSink,
} = require('../observability/sinks/index.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const OTLP_SIGNALS = Object.freeze({ '/v1/logs': 'logs', '/v1/traces': 'traces', '/v1/metrics': 'metrics' });
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The longest recorded spool drain is 17 seconds; two minutes leaves room for a legitimate flush while reporting far before the 25-minute dashboard gap users noticed.
const OUTBOX_NOT_DRAINING_AFTER_MS = 120_000;
const PROCESS_RECORD_HEARTBEAT_INTERVAL_MS = 5_000;
const PROCESS_RECORD_HEARTBEAT_WORKER_SOURCE = [
  "const fs = require('node:fs');",
  "const { parentPort, workerData } = require('node:worker_threads');",
  'parentPort.on(\'message\', (heartbeatAt) => {',
  '  try {',
  "    const record = JSON.parse(fs.readFileSync(workerData.filePath, 'utf8'));",
  '    if (record?.pid !== workerData.pid',
  '      || record.pluginVersion !== workerData.pluginVersion',
  '      || record.scriptPath !== workerData.scriptPath) return;',
  "    const temporaryFile = `${workerData.filePath}.${workerData.pid}.heartbeat`;",
  "    fs.writeFileSync(temporaryFile, `${JSON.stringify({ ...record, heartbeatAt })}\\n`, { encoding: 'utf8', mode: 0o600 });",
  '    fs.renameSync(temporaryFile, workerData.filePath);',
  '  } catch {}',
  '});',
].join('\n');

function startProcessRecordHeartbeat(options) {
  const writer = new Worker(PROCESS_RECORD_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: options,
  });
  writer.on('error', () => {});
  writer.unref();
  const refresh = () => writer.postMessage(new Date().toISOString());
  refresh();
  const timer = setInterval(refresh, PROCESS_RECORD_HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await writer.terminate();
    },
  };
}

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

function defaultSink() {
  return {
    id: DEFAULT_SINK,
    egress: 'loopback',
    outbox: {
      enabled: true,
      endpoint: 'http://127.0.0.1:14318/v1/logs',
      headers: {},
      allowRemote: false,
    },
  };
}

function compareVersions(left, right) {
  const parts = (value) => String(value || '').match(/\d+/g)?.slice(0, 3).map(Number) || [];
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function installedPluginInstallation(home = os.homedir()) {
  try {
    const registryFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const installations = registry.plugins?.['observability@eigenwise-toolshed'];
    if (!Array.isArray(installations)) return null;
    return installations
      .filter((installation) => typeof installation?.version === 'string')
      .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
  } catch {
    return null;
  }
}

function installedPluginVersion(home = os.homedir()) {
  return installedPluginInstallation(home)?.version || null;
}

function installedEnsureScript(installation) {
  if (typeof installation?.installPath !== 'string') return null;
  const script = path.join(installation.installPath, 'lib', 'observability', 'ensure.js');
  try {
    return fs.statSync(script).isFile() ? script : null;
  } catch {
    return null;
  }
}

function startObserverHandoff(successor, options = {}) {
  const child = (options.spawn || spawn)(process.execPath, [
    successor.ensureScript,
    '--handoff',
    '--data-dir', successor.dataDir,
    '--config', successor.configFile,
    '--observer-port', String(successor.port),
  ], {
    detached: true,
    env: { ...process.env, ...(options.environment || {}) },
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) {
    throw new Error(`Could not start installed observer handoff for plugin ${successor.installedVersion}.`);
  }
  if (typeof child.unref === 'function') child.unref();
  return child.pid;
}

function outboxIsStalled(outboxHealth, retryIntervalMs, now = Date.now()) {
  if (Number(outboxHealth?.pending_count) <= 0) return false;
  const lastAttemptAt = Date.parse(outboxHealth?.last_attempt_at || '');
  return Number.isFinite(lastAttemptAt) && now - lastAttemptAt > retryIntervalMs;
}

function outboxIsNotDraining(outboxHealth, now = Date.now()) {
  if (Number(outboxHealth?.pending_count) <= 0) return false;
  const oldestPendingAt = Date.parse(outboxHealth?.oldest_pending_at || '');
  return Number.isFinite(oldestPendingAt) && now - oldestPendingAt > OUTBOX_NOT_DRAINING_AFTER_MS;
}

function observerVersionError(pluginVersion, installedVersion) {
  if (!installedVersion || compareVersions(pluginVersion, installedVersion) >= 0) return null;
  return new Error(`Observer plugin ${pluginVersion} is older than installed version ${installedVersion}.`);
}

function ownPluginVersion() {
  return require('../.claude-plugin/plugin.json').version;
}

function createObserver(options = {}) {
  const host = assertLoopbackHost(options.host || '127.0.0.1');
  const port = Number(options.port === undefined ? 14319 : options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid observer port: ${options.port}`);
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes) || 1024 * 1024);
  const pluginVersion = options.pluginVersion || ownPluginVersion();
  const getInstalledPluginInstallation = options.getInstalledPluginInstallation || (() => installedPluginInstallation(options.home));
  const observerDataDir = path.dirname(options.databaseFile || defaultDatabaseFile());
  const observerConfigFile = options.configFile || defaultConfigPath(observerDataDir);
  const successor = () => {
    const installation = getInstalledPluginInstallation();
    const versionError = observerVersionError(pluginVersion, installation?.version);
    if (!versionError) return { versionError: null };
    const ensureScript = installedEnsureScript(installation);
    if (!ensureScript) return { versionError: null, unavailableInstalledVersion: installation.version };
    return {
      versionError,
      ensureScript,
      installedVersion: installation.version,
      dataDir: observerDataDir,
      configFile: observerConfigFile,
      port,
    };
  };
  const staleObserverError = () => successor().versionError;
  const outboxRetryIntervalMs = Math.max(250, Number(options.outboxIntervalMs) || 1000);
  const hookSpoolDrainBudgetMs = Math.max(10, Math.min(60_000, Number(options.hookSpoolDrainBudgetMs) || DEFAULT_DRAIN_BUDGET_MS));
  const hookSpoolStallMs = Math.max(100, hookSpoolDrainBudgetMs * 4);
  const overriddenOutbox = options.outboxEndpoint
    ? { enabled: true, endpoint: options.outboxEndpoint, headers: options.outboxHeaders || {}, allowRemote: false }
    : null;
  const sink = options.sink || (overriddenOutbox
    ? { id: 'otlp', egress: 'loopback', outbox: overriddenOutbox }
    : defaultSink());
  const outbox = overriddenOutbox || sink.outbox;
  if (!outbox || typeof outbox.enabled !== 'boolean') throw new Error('The observer requires a valid sink outbox contract.');
  const ownsStore = !options.store;
  const store = options.store || openObservabilityStore(options.databaseFile || defaultDatabaseFile(), {
    outboxEnabled: outbox.enabled,
  });
  const outboxDrainer = createOutboxDrainer(store, {
    enabled: outbox.enabled,
    endpoint: outbox.endpoint,
    headers: outbox.headers,
    allowRemote: outbox.allowRemote,
    batchSize: outbox.batchSize,
    mapObservation: outbox.mapObservation,
    encodeBatch: outbox.encodeBatch,
    fetch: options.fetch,
    maxAttempts: options.maxOutboxAttempts || outbox.maxAttempts,
    baseDelayMs: outbox.baseDelayMs,
    maxDelayMs: outbox.maxDelayMs,
  });

  let maintenanceStatus = { failed: false, lastRunAt: null };
  const preserveStorageHeadroom = () => typeof store.preserveStorageHeadroom === 'function'
    ? store.preserveStorageHeadroom({ retentionDays: options.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : options.retentionDays })
    : { state: 'healthy', action: 'none', failure: null };
  const readStoragePressure = () => typeof store.storagePressure === 'function'
    ? store.storagePressure()
    : { state: 'healthy', action: 'none', failure: null };
  const spoolStatus = {
    consecutive_failures: 0,
    last_error: null,
    last_quarantined_at: null,
    last_quarantined_file: null,
    last_success_at: null,
    in_flight_at: null,
  };
  const logger = options.logger || console;
  let retireOutdatedObserver = () => {};
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port || 80}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        const [outboxHealth] = store.queryView('outbox_health', { limit: 1 });
        const versionError = staleObserverError();
        const outboxStalled = outbox.enabled && outboxIsStalled(outboxHealth, outboxRetryIntervalMs);
        const outboxNotDraining = outbox.enabled && outboxIsNotDraining(outboxHealth);
        const spoolDrainStartedAt = Date.parse(spoolStatus.in_flight_at || '');
        const spoolStalled = Number.isFinite(spoolDrainStartedAt) && Date.now() - spoolDrainStartedAt > hookSpoolStallMs;
        const spoolFailed = spoolStatus.consecutive_failures > 0 || spoolStalled;
        const storage = store.storageMetrics();
        const storagePressure = readStoragePressure();
        const storageFailed = storagePressure.state === 'unrecoverable';
        jsonResponse(response, versionError || outboxStalled || outboxNotDraining || spoolFailed || storageFailed ? 503 : 200, {
          ok: !versionError && !outboxStalled && !outboxNotDraining && !spoolFailed && !storageFailed,
          pid: process.pid,
          pluginVersion,
          sink: { id: sink.id, egress: sink.egress, enabled: outbox.enabled },
          outbox: outboxHealth,
          spool: spoolStatus,
          storage: { ...storage, pressure: storagePressure },
          maintenance: maintenanceStatus,
          error: versionError ? 'plugin_version_outdated' : outboxStalled ? 'outbox_stalled' : outboxNotDraining ? 'outbox_not_draining' : spoolStalled ? 'hook_spool_drain_stalled' : spoolFailed ? 'hook_spool_drain_failed' : storageFailed ? 'storage_headroom_unrecoverable' : undefined,
        });
        if (versionError) setImmediate(retireOutdatedObserver);
        return;
      }

      if (request.method === 'POST' && ['/v1/observations', '/v1/ingest'].includes(url.pathname)) {
        const body = await readJson(request, maxBodyBytes);
        if (Array.isArray(body) && body.length === 0) throw requestError(400, 'empty_batch');
        const results = Array.isArray(body) ? store.ingestBatch(body) : [store.ingest(body)];
        const storagePressure = preserveStorageHeadroom();
        const rejected = results.some((result) => !result.accepted);
        jsonResponse(response, rejected ? 422 : 200, {
          committed: results.every((result) => result.committed),
          results,
          storagePressure,
        });
        return;
      }

      if (request.method === 'POST' && OTLP_SIGNALS[url.pathname]) {
        const body = await readJson(request, maxBodyBytes);
        const observations = otlpToObservations(OTLP_SIGNALS[url.pathname], body, { projectId: options.projectId });
        if (observations.length === 0) {
          jsonResponse(response, 200, {});
          return;
        }
        const results = store.ingestBatch(observations);
        preserveStorageHeadroom();
        if (results.some((result) => !result.accepted)) {
          jsonResponse(response, 422, { error: 'observation_rejected' });
          return;
        }
        if (!results.every((result) => result.committed)) {
          jsonResponse(response, 503, { error: 'commit_incomplete' });
          return;
        }
        jsonResponse(response, 200, {});
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/v1/views/')) {
        const view = decodeURIComponent(url.pathname.slice('/v1/views/'.length));
        if (!RESOLVED_VIEWS.includes(view)) throw requestError(404, 'view_not_found');
        const limit = Number(url.searchParams.get('limit') || 1000);
        jsonResponse(response, 200, { view, rows: store.queryView(view, { limit }) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/outbox/requeue') {
        jsonResponse(response, 200, { requeued: store.requeueExhaustedOutbox() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/outbox/flush') {
        const result = await drainOutbox();
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
  let spoolTimer = null;
  let outboxTimer = null;
  let maintenanceStartTimer = null;
  let maintenanceTimer = null;
  let staleVersionTimer = null;
  let processRecordHeartbeat = null;
  let maintaining = false;
  let retiring = false;
  let drainingSpool = false;
  const spoolPath = options.hookSpoolFile || process.env.WORKBENCH_HOOK_SPOOL || defaultSpoolPath();
  const drainSpool = async () => {
    if (drainingSpool) return null;
    drainingSpool = true;
    spoolStatus.in_flight_at = new Date().toISOString();
    try {
      const result = await drainHookSpool({
        spoolPath,
        store,
        projectId: options.projectId,
        drainBudgetMs: hookSpoolDrainBudgetMs,
        failureState: spoolStatus,
        failureThreshold: options.hookSpoolFailureThreshold,
      });
      preserveStorageHeadroom();
      return result;
    } catch (error) {
      logger.error('Observer hook spool drain failed', {
        code: typeof error?.code === 'string' ? error.code : 'hook_spool_drain_failed',
        message: error instanceof Error ? error.message : String(error),
        file: `${spoolPath}.draining`,
      });
      return null;
    } finally {
      spoolStatus.in_flight_at = null;
      drainingSpool = false;
    }
  };
  const drainOutbox = () => outbox.enabled
    ? outboxDrainer.flush().catch(() => null)
    : Promise.resolve(null);
  retireOutdatedObserver = () => {
    const nextObserver = successor();
    if (retiring || !nextObserver.versionError) return;
    try {
      (options.startObserverHandoff || startObserverHandoff)(nextObserver, options);
    } catch (error) {
      logger.error?.(`Observer handoff failed; plugin ${pluginVersion} remains active while installed plugin ${nextObserver.installedVersion} waits: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    retiring = true;
    logger.info?.(`Observer handoff: retiring plugin ${pluginVersion} for installed plugin ${nextObserver.installedVersion} via ${nextObserver.ensureScript}.`);
    if (maintenanceStartTimer) clearTimeout(maintenanceStartTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (spoolTimer) clearInterval(spoolTimer);
    if (outboxTimer) clearInterval(outboxTimer);
    if (staleVersionTimer) clearInterval(staleVersionTimer);
    if (processRecordHeartbeat) {
      void processRecordHeartbeat.stop();
      processRecordHeartbeat = null;
    }
    if (started && server.listening) {
      started = false;
      server.close(() => { if (ownsStore) store.close(); });
    }
  };
  const runMaintenance = () => {
    if (maintaining) return null;
    maintaining = true;
    try {
      const retention = typeof store.prune === 'function'
        ? store.prune({ retentionDays: options.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : options.retentionDays })
        : null;
      const result = { retention, pressure: preserveStorageHeadroom() };
      maintenanceStatus = { failed: false, lastRunAt: new Date().toISOString(), result };
      return result;
    } catch {
      maintenanceStatus = { failed: true, lastRunAt: new Date().toISOString() };
      return null;
    } finally {
      maintaining = false;
    }
  };
  return {
    host,
    port,
    server,
    sink,
    store,
    async start() {
      if (started) return server.address();
      const versionError = staleObserverError();
      if (versionError) throw versionError;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      started = true;
      processRecordHeartbeat = startProcessRecordHeartbeat({
        filePath: path.join(path.dirname(options.databaseFile || defaultDatabaseFile()), 'observer.pid.json'),
        pid: process.pid,
        pluginVersion,
        scriptPath: __filename,
      });
      maintenanceStartTimer = setTimeout(runMaintenance, 0);
      if (typeof maintenanceStartTimer.unref === 'function') maintenanceStartTimer.unref();
      maintenanceTimer = setInterval(
        runMaintenance,
        Math.max(60_000, Number(options.maintenanceIntervalMs) || DEFAULT_MAINTENANCE_INTERVAL_MS),
      );
      if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
      drainSpool();
      spoolTimer = setInterval(drainSpool, Math.max(250, Number(options.hookSpoolIntervalMs) || 1000));
      if (typeof spoolTimer.unref === 'function') spoolTimer.unref();
      if (outbox.enabled) {
        void drainOutbox();
        outboxTimer = setInterval(() => { void drainOutbox(); }, outboxRetryIntervalMs);
        if (typeof outboxTimer.unref === 'function') outboxTimer.unref();
      }
      staleVersionTimer = setInterval(retireOutdatedObserver, outboxRetryIntervalMs);
      if (typeof staleVersionTimer.unref === 'function') staleVersionTimer.unref();
      return server.address();
    },
    async close() {
      if (maintenanceStartTimer) {
        clearTimeout(maintenanceStartTimer);
        maintenanceStartTimer = null;
      }
      if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
      }
      if (spoolTimer) {
        clearInterval(spoolTimer);
        spoolTimer = null;
      }
      if (outboxTimer) {
        clearInterval(outboxTimer);
        outboxTimer = null;
      }
      if (staleVersionTimer) {
        clearInterval(staleVersionTimer);
        staleVersionTimer = null;
      }
      if (processRecordHeartbeat) {
        await processRecordHeartbeat.stop();
        processRecordHeartbeat = null;
      }
      await drainSpool();
      await drainOutbox();
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
    if (argument === '--config' && next) { options.configFile = next; index += 1; continue; }
    if (argument === '--outbox-endpoint' && next) { options.outboxEndpoint = next; index += 1; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function defaultDatabaseFile() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Eigenwise', 'Workbench', 'observability.db');
}

function loadConfiguredSink(databaseFile, configFile) {
  const filePath = configFile || defaultConfigPath(path.dirname(databaseFile));
  return resolveSink(readObservabilityConfig(filePath, { defaultSink: DEFAULT_SINK }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.databaseFile) options.databaseFile = defaultDatabaseFile();
  if (!options.outboxEndpoint) options.sink = loadConfiguredSink(options.databaseFile, options.configFile);
  const observer = createObserver(options);
  const address = await observer.start();
  process.stdout.write(`Observability observer listening on ${address.address}:${address.port}\n`);
  const stop = async () => {
    await observer.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Observability observer failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertLoopbackHost,
  compareVersions,
  createObserver,
  defaultDatabaseFile,
  installedPluginVersion,
  loadConfiguredSink,
  outboxIsNotDraining,
  outboxIsStalled,
  parseArgs,
};
