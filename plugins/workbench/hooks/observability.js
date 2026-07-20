'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SPOOL_CAP_BYTES = 8 * 1024 * 1024;
const HARD_TIMEOUT_MS = 1500;

const EVENT_MAP = Object.freeze({
  SessionStart: 'hook.session_start',
  SessionEnd: 'hook.session_end',
  UserPromptSubmit: 'hook.user_prompt_submit',
  PreToolUse: 'hook.pre_tool_use',
  PostToolUse: 'hook.post_tool_use',
  Stop: 'hook.stop',
  SubagentStart: 'hook.subagent_start',
  SubagentStop: 'hook.subagent_stop',
  TaskCompleted: 'hook.task_completed',
});

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function projectMetadata(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return {};
  const basename = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const projectName = basename.replace(/[^A-Za-z0-9_.:@-]/g, '-').slice(0, 64);
  if (!projectName || !/^[A-Za-z0-9]/.test(projectName)) return {};
  return {
    project_id: crypto.createHash('sha256').update(cwd).digest('hex'),
    project_name: projectName,
  };
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

function effort(value) {
  return typeof value === 'string' && EFFORTS.has(value) ? value : null;
}

function nonnegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function serializedSizeMeasurements(name, value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return [];
  const bytes = Buffer.byteLength(serialized, 'utf8');
  return [
    { name: `${name}_bytes`, value: bytes, unit: 'bytes', scope: 'attempt', quality: 'exact_client' },
    { name: `${name}_tokens_estimate`, value: bytes / 4, unit: 'tokens', scope: 'attempt', quality: 'estimate' },
  ];
}

function toolFacets(rawName) {
  const name = identifier(rawName);
  if (!name) return {};
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    const facets = { tool_name: name, tool_kind: 'mcp', is_mcp: true };
    assign(facets, 'mcp_server', identifier(server));
    assign(facets, 'mcp_tool', identifier(tool));
    return facets;
  }
  return { tool_name: name, tool_kind: 'native', is_mcp: false };
}

// Build a canonical, metadata-only observation from a hook payload. Prompt text,
// tool inputs/results, cwd, transcript paths, and session titles are never retained.
function buildObservation(payload, now) {
  if (!payload || typeof payload !== 'object') return null;
  const eventName = EVENT_MAP[payload.hook_event_name];
  if (!eventName) return null;

  const observedAt = (now instanceof Date ? now : new Date()).toISOString();
  const attributes = {};
  const project = projectMetadata(payload.cwd);
  assign(attributes, 'project_name', project.project_name);
  const permissionMode = identifier(payload.permission_mode);
  const effortValue = effort(payload.effort);

  if (eventName === 'hook.session_start') {
    assign(attributes, 'permission_mode', permissionMode);
    assign(attributes, 'effort', effortValue);
  } else if (eventName === 'hook.session_end' || eventName === 'hook.stop') {
    assign(attributes, 'end_reason', identifier(first(payload.reason, payload.end_reason, payload.stop_reason)));
    assign(attributes, 'permission_mode', permissionMode);
    assign(attributes, 'effort', effortValue);
  } else if (eventName === 'hook.user_prompt_submit') {
    assign(attributes, 'permission_mode', permissionMode);
    assign(attributes, 'effort', effortValue);
  } else if (eventName === 'hook.pre_tool_use') {
    Object.assign(attributes, toolFacets(payload.tool_name));
    assign(attributes, 'permission_mode', permissionMode);
  } else if (eventName === 'hook.post_tool_use') {
    Object.assign(attributes, toolFacets(payload.tool_name));
    assign(attributes, 'status', identifier(first(payload.status, payload.tool_status)));
    assign(attributes, 'error_type', identifier(payload.error_type));
    assign(attributes, 'error_code', identifier(payload.error_code));
  } else if (eventName === 'hook.subagent_start') {
    assign(attributes, 'agent_type', identifier(first(payload.agent_type, payload.subagent_type)));
    assign(attributes, 'model', identifier(payload.model));
    assign(attributes, 'effort', effortValue);
  } else if (eventName === 'hook.subagent_stop') {
    assign(attributes, 'agent_type', identifier(first(payload.agent_type, payload.subagent_type)));
    assign(attributes, 'model', identifier(payload.model));
    assign(attributes, 'effort', effortValue);
    assign(attributes, 'end_reason', identifier(first(payload.reason, payload.end_reason)));
    assign(attributes, 'status', identifier(payload.status));
  } else if (eventName === 'hook.task_completed') {
    assign(attributes, 'task_status', identifier(first(payload.task_status, payload.status)));
  }

  const observation = {
    source: 'hook',
    source_event_id: `hook_${eventName}_${observedAt}_${identifier(payload.session_id) || 'unknown'}_${identifier(first(payload.tool_use_id, payload.task_id, payload.agent_id)) || 'na'}`,
    source_schema: 'hook-v1',
    observed_at: observedAt,
    event_name: eventName,
    attributes,
  };
  assign(observation, 'project_id', project.project_id);
  assign(observation, 'session_id', identifier(payload.session_id));
  assign(observation, 'prompt_id', identifier(first(payload.prompt_id, payload.promptId)));
  assign(observation, 'agent_id', identifier(payload.agent_id));
  assign(observation, 'parent_agent_id', identifier(payload.parent_agent_id));
  assign(observation, 'tool_use_id', identifier(payload.tool_use_id));
  assign(observation, 'task_id', identifier(payload.task_id));
  const measurements = [];
  if (eventName === 'hook.post_tool_use') {
    if (Object.hasOwn(payload, 'tool_input')) {
      measurements.push(...serializedSizeMeasurements('tool_input', payload.tool_input));
    }
    if (Object.hasOwn(payload, 'tool_response')) {
      measurements.push(...serializedSizeMeasurements('tool_result', payload.tool_response));
    } else if (Object.hasOwn(payload, 'tool_result')) {
      measurements.push(...serializedSizeMeasurements('tool_result', payload.tool_result));
    }
  }
  const durationMs = nonnegativeNumber(first(payload.duration_ms, payload.durationMs));
  if (durationMs !== null && ['hook.post_tool_use', 'hook.subagent_stop'].includes(eventName)) {
    measurements.push({ name: 'duration_ms', value: durationMs, unit: 'ms', scope: 'attempt', quality: 'exact_client' });
  }
  if (measurements.length > 0) observation.measurements = measurements;
  return observation;
}

// Append one observation as a JSON line, bounded and fail-open. A spool that would
// exceed the cap is truncated rather than allowed to grow without limit.
function spool(spoolPath, observation) {
  try {
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    let size = 0;
    try { size = fs.statSync(spoolPath).size; } catch { size = 0; }
    const line = JSON.stringify(observation) + '\n';
    if (size + line.length > SPOOL_CAP_BYTES) {
      fs.writeFileSync(spoolPath, line, { encoding: 'utf8', mode: 0o600 });
    } else {
      fs.appendFileSync(spoolPath, line, { encoding: 'utf8', mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

function defaultSpoolPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench', 'hook-spool.jsonl');
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(finish, HARD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const observation = buildObservation(payload, new Date());
    if (observation) spool(process.env.WORKBENCH_HOOK_SPOOL || defaultSpoolPath(), observation);
  } catch {
    // Fail open: observability must never block Claude work.
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { EVENT_MAP, buildObservation, defaultSpoolPath, projectMetadata, spool };
