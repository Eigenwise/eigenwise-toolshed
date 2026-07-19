#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOOPBACK = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
// The pipeline processor order is a hard contract from SQ-471: bound memory first,
// drop unwanted signals, strip content, then batch. Never insert a debug exporter.
const REQUIRED_PROCESSOR_ORDER = Object.freeze(['memory_limiter', 'filter/signals', 'transform/redact', 'batch']);
const FORBIDDEN_EXPORTERS = Object.freeze(['debug', 'logging']);

const PROJECT_LABEL_PROMOTION = 'set(attributes["project.id"], resource.attributes["project.id"]) where resource.attributes["project.id"] != nil';

// Attribute keys the collector strips before anything leaves the process. Defense in
// depth: the observer allowlists again, but content must never reach the wire.
const REDACTED_KEYS = Object.freeze([
  'prompt', 'input', 'output', 'body', 'content', 'text', 'message', 'messages',
  'tool_input', 'tool_response', 'arguments', 'result', 'cwd', 'transcript_path',
  'user', 'user_id', 'email', 'authorization', 'api_key', 'token', 'env', 'headers',
]);
const REDACTION_STATEMENTS = Object.freeze(REDACTED_KEYS.map((key) => `delete_key(attributes, "${key}")`));
const SINK_EXPORTER = 'otlphttp/sink';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(['content-length', 'content-type', 'host']);

function normalizeSinkExporter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('sink exporter declaration must be an object');
  if (typeof value.endpoint !== 'string' || value.endpoint.trim().length === 0) {
    throw new Error('sink exporter endpoint is required');
  }
  const url = new URL(value.endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('sink exporter endpoint must use HTTP(S)');
  if (url.username || url.password) throw new Error('sink exporter URL credentials are not allowed');
  if (url.search || url.hash) throw new Error('sink exporter endpoint cannot include a query or fragment');
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && value.allowRemote !== true) throw new Error('remote sink exporter requires explicit egress');
  if (!local && url.protocol !== 'https:') throw new Error('remote sink exporter must use HTTPS');

  const headers = value.headers === undefined ? {} : value.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('sink exporter headers must be an object');
  }
  const normalizedHeaders = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`invalid sink exporter header name: ${name}`);
    }
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new Error(`sink exporter header ${name} must be a single-line string`);
    }
    normalizedHeaders[name] = headerValue;
  }
  return {
    endpoint: url.toString(),
    headers: normalizedHeaders,
    allowRemote: !local,
  };
}

function buildCollectorConfig(options = {}) {
  const receiverEndpoint = options.receiverEndpoint || '127.0.0.1:4318';
  const observerEndpoint = options.observerEndpoint || 'http://127.0.0.1:14319';
  const queueDir = options.queueDirectory || path.join(defaultDataDir(), 'collector-queue');
  const sinkExporter = normalizeSinkExporter(options.sinkExporter);
  const pipelineExporters = ['otlphttp/observer', ...(sinkExporter ? [SINK_EXPORTER] : [])];
  const exporters = {
    'otlphttp/observer': {
      endpoint: observerEndpoint,
      encoding: 'json',
      compression: 'none',
      tls: { insecure: true },
      sending_queue: { enabled: true, storage: 'file_storage/observer_queue' },
      retry_on_failure: { enabled: true },
    },
  };
  if (sinkExporter) {
    exporters[SINK_EXPORTER] = {
      endpoint: sinkExporter.endpoint,
      ...(Object.keys(sinkExporter.headers).length > 0 ? { headers: sinkExporter.headers } : {}),
    };
  }

  const pipeline = (receivers, pipelineExporterNames) => ({
    receivers,
    processors: [...REQUIRED_PROCESSOR_ORDER],
    exporters: pipelineExporterNames,
  });

  return {
    extensions: {
      'file_storage/observer_queue': { directory: queueDir, timeout: '2s', create_directory: true },
    },
    receivers: {
      otlp: { protocols: { http: { endpoint: receiverEndpoint } } },
    },
    processors: {
      memory_limiter: { check_interval: '1s', limit_mib: 128, spike_limit_mib: 32 },
      'filter/signals': {
        error_mode: 'ignore',
        // Keep only telemetry the ledger understands; drop everything else early.
        logs: { log_record: ['not IsMatch(attributes["event.name"], "^(claude_code|agent_sdk)\\\\.|^(mcp_server_connection|hook_execution_(start|complete))$")'] },
      },
      'transform/redact': {
        error_mode: 'ignore',
        log_statements: [{ context: 'log', statements: [...REDACTION_STATEMENTS] }],
        trace_statements: [{ context: 'span', statements: [...REDACTION_STATEMENTS] }],
        metric_statements: [{ context: 'datapoint', statements: [PROJECT_LABEL_PROMOTION, ...REDACTION_STATEMENTS] }],
      },
      batch: { timeout: '5s', send_batch_size: 256 },
    },
    exporters,
    service: {
      extensions: ['file_storage/observer_queue'],
      telemetry: { metrics: { level: 'none' } },
      pipelines: {
        logs: pipeline(['otlp'], [...pipelineExporters]),
        traces: pipeline(['otlp'], [...pipelineExporters]),
        metrics: pipeline(['otlp'], [...pipelineExporters]),
      },
    },
  };
}

function endpointOf(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? value.endpoint : undefined;
}

function validateCollectorConfig(config, options = {}) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config is not an object'];

  let declaredSink = null;
  try {
    declaredSink = normalizeSinkExporter(options.sinkExporter);
  } catch (error) {
    errors.push(`invalid sink exporter declaration: ${error.message}`);
  }

  const receiver = endpointOf(config.receivers?.otlp?.protocols?.http);
  if (!receiver || !LOOPBACK.test(receiver)) errors.push(`otlp http receiver must be loopback, got ${receiver}`);

  const allowedExporters = new Set(['otlphttp/observer', ...(declaredSink ? [SINK_EXPORTER] : [])]);
  for (const [name, exporter] of Object.entries(config.exporters || {})) {
    const base = name.split('/')[0];
    if (FORBIDDEN_EXPORTERS.includes(base)) errors.push(`forbidden exporter: ${name}`);
    if (!allowedExporters.has(name)) errors.push(`unexpected exporter: ${name}`);
    if (name !== SINK_EXPORTER) {
      const endpoint = endpointOf(exporter);
      if (!endpoint || !LOOPBACK.test(endpoint)) errors.push(`exporter ${name} must target loopback, got ${endpoint}`);
    }
  }

  const observerExporter = config.exporters?.['otlphttp/observer'];
  if (!observerExporter) {
    errors.push('missing otlphttp/observer exporter');
  } else {
    if (observerExporter.encoding !== 'json') errors.push('otlphttp/observer encoding must be json');
    if (observerExporter.compression !== 'none') errors.push('otlphttp/observer compression must be none');
  }

  const sinkExporter = config.exporters?.[SINK_EXPORTER];
  if (declaredSink && !sinkExporter) {
    errors.push(`missing ${SINK_EXPORTER} exporter`);
  } else if (declaredSink && sinkExporter) {
    if (endpointOf(sinkExporter) !== declaredSink.endpoint) {
      errors.push(`${SINK_EXPORTER} endpoint must match the declared sink endpoint`);
    }
    const actualHeaders = sinkExporter.headers || {};
    const declaredHeaders = declaredSink.headers || {};
    const sorted = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
    if (sorted(actualHeaders) !== sorted(declaredHeaders)) {
      errors.push(`${SINK_EXPORTER} headers must match the declared sink headers`);
    }
    if (declaredSink.allowRemote && sinkExporter.tls?.insecure === true) {
      errors.push(`${SINK_EXPORTER} cannot disable TLS verification for remote egress`);
    }
  }

  const redact = config.processors?.['transform/redact'];
  if (!redact) {
    errors.push('missing transform/redact (content stripping) processor');
  } else {
    const groups = [
      ['log_statements', 'log', REDACTION_STATEMENTS],
      ['trace_statements', 'span', REDACTION_STATEMENTS],
      ['metric_statements', 'datapoint', [PROJECT_LABEL_PROMOTION, ...REDACTION_STATEMENTS]],
    ];
    for (const [name, context, expected] of groups) {
      const group = redact[name];
      if (!Array.isArray(group) || group.length !== 1 || group[0]?.context !== context
        || JSON.stringify(group[0]?.statements) !== JSON.stringify(expected)) {
        errors.push(name === 'metric_statements'
          ? 'transform/redact metric_statements must promote resource project.id and preserve content stripping'
          : `transform/redact ${name} must preserve the required content stripping statements`);
      }
    }
  }

  const pipelines = config.service?.pipelines || {};
  const expectedExporters = ['otlphttp/observer', ...(declaredSink ? [SINK_EXPORTER] : [])];
  for (const signal of ['logs', 'traces', 'metrics']) {
    const processors = pipelines[signal]?.processors;
    if (JSON.stringify(processors) !== JSON.stringify(REQUIRED_PROCESSOR_ORDER)) {
      errors.push(`pipeline ${signal} processor order must be ${REQUIRED_PROCESSOR_ORDER.join(',')}, got ${JSON.stringify(processors)}`);
    }
    const exporters = pipelines[signal]?.exporters;
    if (JSON.stringify(exporters) !== JSON.stringify(expectedExporters)) {
      errors.push(`pipeline ${signal} exporters must be ${expectedExporters.join(',')}, got ${JSON.stringify(exporters)}`);
    }
  }

  const queueName = 'file_storage/observer_queue';
  if (!config.extensions?.[queueName]) errors.push('missing file_storage/observer_queue extension');
  if (!(config.service?.extensions || []).includes(queueName)) errors.push('file_storage extension not enabled in service');
  for (const [name, exporter] of Object.entries(config.exporters || {})) {
    if (exporter?.sending_queue && exporter.sending_queue.storage !== queueName) {
      errors.push(`exporter ${name} sending_queue.storage must be ${queueName}`);
    }
  }
  return errors;
}

function quoteScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function inlineYaml(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return `[${value.map(quoteScalar).join(', ')}]`;
    }
    return null;
  }
  if (value && typeof value === 'object') return Object.keys(value).length === 0 ? '{}' : null;
  return quoteScalar(value);
}

function yamlLines(value, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      const inline = inlineYaml(item);
      if (inline !== null) {
        lines.push(`${pad}- ${inline}`);
        continue;
      }
      const childPad = '  '.repeat(indent + 1);
      const childLines = yamlLines(item, indent + 1);
      lines.push(`${pad}- ${childLines[0].slice(childPad.length)}`);
      lines.push(...childLines.slice(1));
    }
    return lines;
  }

  if (value && typeof value === 'object') {
    const lines = [];
    for (const [key, child] of Object.entries(value)) {
      const inline = inlineYaml(child);
      if (inline !== null) lines.push(`${pad}${key}: ${inline}`);
      else lines.push(`${pad}${key}:`, ...yamlLines(child, indent + 1));
    }
    return lines;
  }

  return [`${pad}${quoteScalar(value)}`];
}

function toYaml(value, indent = 0) {
  return yamlLines(value, indent).join('\n');
}

function renderCollectorYaml(options = {}) {
  const config = buildCollectorConfig(options);
  const errors = validateCollectorConfig(config, { sinkExporter: options.sinkExporter });
  if (errors.length > 0) throw new Error(`invalid collector config: ${errors.join('; ')}`);
  return `# Generated by workbench install-otel-collector. The receiver is loopback-only;
# content is stripped before declared exports. Do not add a debug/logging exporter.\n${toYaml(config).replace(/^\n/, '')}\n`;
}

function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench');
}

function writeCollectorConfig(targetPath, options = {}) {
  const yaml = renderCollectorYaml(options);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, yaml, { encoding: 'utf8', mode: 0o600 });
  return targetPath;
}

function main() {
  const target = process.argv[2] || path.join(defaultDataDir(), 'otel-collector-config.yaml');
  const written = writeCollectorConfig(target);
  process.stdout.write(`Wrote loopback OTel Collector config to ${written}\n`);
  process.stdout.write('Run: otelcol-contrib --config ' + written + '\n');
  process.stdout.write('It receives OTLP/HTTP on 127.0.0.1:4318 and commits to the Workbench observer on 127.0.0.1:14319.\n');
}

if (require.main === module) main();

module.exports = {
  PROJECT_LABEL_PROMOTION,
  REDACTED_KEYS,
  REQUIRED_PROCESSOR_ORDER,
  SINK_EXPORTER,
  buildCollectorConfig,
  normalizeSinkExporter,
  renderCollectorYaml,
  toYaml,
  validateCollectorConfig,
  writeCollectorConfig,
};
