'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GROK_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/responses';
const GROK_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth/token';
const GROK_VERSION_FALLBACK = '0.2.112';
const GROK_MODELS = [
  { id: 'grok-4.5', context: 500000, reasoning: true },
  { id: 'grok-build', context: 500000, reasoning: true },
  { id: 'grok-4.3', context: 131072, reasoning: true },
  { id: 'grok-4.1-fast', context: 131072, reasoning: false },
];

function grokDirectory(home = os.homedir()) {
  return process.env.CODEX_GATEWAY_GROK_HOME || path.join(home, '.grok');
}

function grokAuthPath(home) {
  return path.join(grokDirectory(home), 'auth.json');
}

function grokVersionPath(home) {
  return path.join(grokDirectory(home), 'version.json');
}

function grokModelCachePath(home) {
  return path.join(grokDirectory(home), 'models_cache.json');
}

function firstAuthEntry(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const entry = Object.entries(auth).find(([key, value]) => key.startsWith('https://auth.x.ai::') && value && typeof value === 'object');
  return entry ? { key: entry[0], value: entry[1] } : null;
}

function readGrokAuth({ file = grokAuthPath() } = {}) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new Error('Grok CLI auth is missing. Run `grok` and log in again.');
  }
  const entry = firstAuthEntry(parsed);
  if (!entry || typeof entry.value.key !== 'string' || !entry.value.key) {
    throw new Error('Grok CLI auth is invalid. Run `grok` and log in again.');
  }
  return { auth: parsed, entry };
}

function expiresAtMillis(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  const numeric = Number(value);
  return numeric < 100000000000 ? numeric * 1000 : numeric;
}

function authExpiresSoon(entry, now = Date.now(), skewMs = 5 * 60 * 1000) {
  const expiresAt = expiresAtMillis(entry?.value?.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= now + skewMs;
}

function writeGrokAuth(file, auth) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function oidcTokenEndpoint(entry, request) {
  const issuer = typeof entry?.value?.oidc_issuer === 'string' && entry.value.oidc_issuer
    ? entry.value.oidc_issuer.replace(/\/$/, '')
    : 'https://auth.x.ai';
  try {
    const discovery = await request(`${issuer}/.well-known/openid-configuration`);
    if (discovery.status >= 200 && discovery.status < 300 && typeof discovery.body?.token_endpoint === 'string') {
      return discovery.body.token_endpoint;
    }
  } catch {}
  return issuer === 'https://auth.x.ai' ? GROK_TOKEN_ENDPOINT : `${issuer}/oauth/token`;
}

async function refreshGrokAuth({ file = grokAuthPath(), request = requestJson } = {}) {
  const current = readGrokAuth({ file });
  const { entry } = current;
  if (typeof entry.value.refresh_token !== 'string' || !entry.value.refresh_token || typeof entry.value.oidc_client_id !== 'string' || !entry.value.oidc_client_id) {
    throw new Error('Grok CLI auth cannot refresh. Run `grok` and log in again.');
  }
  let response;
  try {
    const tokenEndpoint = await oidcTokenEndpoint(entry, request);
    response = await request(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entry.value.refresh_token,
        client_id: entry.value.oidc_client_id,
      }).toString(),
    });
  } catch {
    throw new Error('Grok CLI auth refresh failed. Run `grok` and log in again.');
  }
  if (response.status < 200 || response.status >= 300 || typeof response.body?.access_token !== 'string' || !response.body.access_token) {
    throw new Error('Grok CLI auth refresh failed. Run `grok` and log in again.');
  }
  entry.value.key = response.body.access_token;
  if (typeof response.body.refresh_token === 'string' && response.body.refresh_token) entry.value.refresh_token = response.body.refresh_token;
  const lifetimeSeconds = Number(response.body.expires_in);
  if (Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0) entry.value.expires_at = Date.now() + lifetimeSeconds * 1000;
  writeGrokAuth(file, current.auth);
  return entry.value.key;
}

async function grokAccessToken(options = {}) {
  const current = readGrokAuth(options);
  if (!authExpiresSoon(current.entry, options.now, options.skewMs)) return current.entry.value.key;
  return refreshGrokAuth(options);
}

function readGrokVersion({ file = grokVersionPath() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = typeof parsed?.version === 'string' ? parsed.version : typeof parsed?.client_version === 'string' ? parsed.client_version : null;
    if (value && /^\d+\.\d+\.\d+/.test(value)) return value;
  } catch {}
  return GROK_VERSION_FALLBACK;
}

function grokHeaders(token, model, version = readGrokVersion()) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': `xai-grok-build/${version}`,
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'xai-grok-cli',
    'x-grok-model-override': model,
  };
}

function inputText(text) {
  return { type: 'input_text', text: String(text || '') };
}

function outputText(text) {
  return { type: 'output_text', text: String(text || '') };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
}

function translateContent(message) {
  const content = Array.isArray(message?.content) ? message.content : [message?.content];
  const items = [];
  for (const block of content) {
    if (typeof block === 'string') items.push(message.role === 'assistant' ? outputText(block) : inputText(block));
    else if (block?.type === 'text') items.push(message.role === 'assistant' ? outputText(block.text) : inputText(block.text));
    else if (block?.type === 'tool_use') items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
    else if (block?.type === 'tool_result') items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: textFromContent(block.content) });
  }
  return items;
}

function translateInput(payload) {
  const input = [];
  const system = payload?.system;
  const systemText = typeof system === 'string' ? system : Array.isArray(system)
    ? system.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '';
  if (systemText) input.push({ role: 'developer', content: [inputText(systemText)] });
  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
    const content = translateContent(message);
    if (content.length) input.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return input;
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((tool) => tool?.name).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || undefined,
    parameters: tool.input_schema || { type: 'object', properties: {} },
  }));
}

function translateRequest(payload, model) {
  const effort = payload?.output_config?.effort;
  const request = {
    model,
    input: translateInput(payload),
    max_output_tokens: payload?.max_tokens,
    stream: payload?.stream === true,
  };
  const tools = translateTools(payload?.tools);
  if (tools?.length) request.tools = tools;
  if (typeof effort === 'string') request.reasoning = { effort };
  return request;
}

function anthropicUsage(usage) {
  return {
    input_tokens: Number(usage?.input_tokens) || 0,
    output_tokens: Number(usage?.output_tokens) || 0,
    output_tokens_details: { reasoning_tokens: Number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens) || 0 },
  };
}

function responseContent(response) {
  const content = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text') content.push({ type: 'text', text: part.text || '' });
      }
    }
    if (item?.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(item.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    }
  }
  return content;
}

function translateResponse(response, model) {
  const content = responseContent(response);
  return {
    id: response?.id || `msg_grok_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: anthropicUsage(response?.usage),
  };
}

function sseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function createGrokSseTransformer(write, model) {
  let started = false;
  let stopped = false;
  let index = 0;
  const toolIndexes = new Map();
  function start(response) {
    if (started) return;
    started = true;
    write(sseFrame({ type: 'message_start', message: { id: response?.id || `msg_grok_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsage(response?.usage) } }));
  }
  function stop(usage, reason = 'end_turn') {
    if (stopped) return;
    stopped = true;
    write(sseFrame({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: anthropicUsage(usage) }));
    write(sseFrame({ type: 'message_stop' }));
  }
  return {
    event(event) {
      const response = event?.response;
      if (event?.type === 'response.created') return start(response);
      if (event?.type === 'response.output_text.delta') {
        start(response);
        if (index === 0) write(sseFrame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
        write(sseFrame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.delta || '' } }));
        return;
      }
      if (event?.type === 'response.function_call_arguments.delta') {
        start(response);
        const callId = event.item_id || event.call_id || 'tool';
        if (!toolIndexes.has(callId)) {
          index += 1;
          toolIndexes.set(callId, index);
          write(sseFrame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name: event.name || '', input: {} } }));
        }
        write(sseFrame({ type: 'content_block_delta', index: toolIndexes.get(callId), delta: { type: 'input_json_delta', partial_json: event.delta || '' } }));
        return;
      }
      if (event?.type === 'response.completed') {
        start(response);
        for (let closeIndex = 0; closeIndex <= index; closeIndex += 1) write(sseFrame({ type: 'content_block_stop', index: closeIndex }));
        return stop(response?.usage, responseContent(response).some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
      }
      if (event?.type === 'error' || event?.type === 'response.failed') {
        const message = event?.error?.message || response?.error?.message || 'Grok response failed';
        write(sseFrame({ type: 'error', error: { type: 'api_error', message: `codex-gateway: Grok upstream failed: ${message}` } }));
      }
    },
    end() { if (started && !stopped) stop({}, 'end_turn'); },
  };
}

function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const transport = url.startsWith('https:') ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        resolve({ status: response.statusCode || 0, headers: response.headers, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

function grokPickerId(model) {
  return String(model || '').replace(/^grok-/, '').replace(/\./g, '-');
}

function grokModelFromPicker(id, models = GROK_MODELS.map((model) => model.id)) {
  const match = models.find((model) => grokPickerId(model) === id);
  return match || `grok-${id}`;
}

function grokModelIdsFromCache({ file = grokModelCachePath() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed?.data) ? parsed.data : [];
    const ids = values.map((model) => typeof model === 'string' ? model : model?.id).filter((id) => /^grok-[a-z0-9.-]+$/i.test(id));
    return [...new Set(ids)];
  } catch { return []; }
}

module.exports = {
  GROK_ENDPOINT,
  GROK_MODELS,
  GROK_VERSION_FALLBACK,
  authExpiresSoon,
  anthropicUsage,
  createGrokSseTransformer,
  grokAccessToken,
  grokHeaders,
  grokModelFromPicker,
  grokModelIdsFromCache,
  grokPickerId,
  readGrokAuth,
  readGrokVersion,
  refreshGrokAuth,
  responseContent,
  translateRequest,
  translateResponse,
};
