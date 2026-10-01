'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { spawnGatewayProcess, stopGatewayChild } = require('./support.js');

const MODELS = ['gpt-6.1-sol', 'codex-auto', 'claude-opus-5-5[1m]'];
const UPSTREAM_MODELS = [...MODELS, 'claude-opus-5-5'];
const CASES = ['projectEnv', 'bareMain', 'agentFrontmatter', 'proactiveCompaction', 'recognizedClaude'];
const COMPACT_PROMPT = 'You are a helpful AI assistant tasked with summarizing conversations.';

function initialReport() {
  return Object.fromEntries(CASES.map((name) => [name, { status: 'UNVERIFIED' }]));
}

function frame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completion(model, content, inputTokens) {
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model,
    content, stop_reason: 'end_turn', usage: { input_tokens: inputTokens, output_tokens: 1 } };
  return message;
}

function streamCompletion(message) {
  let output = frame('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  for (const [index, contentBlock] of message.content.entries()) {
    const isText = contentBlock.type === 'text';
    const initialContent = isText ? { type: 'text', text: '' } : { ...contentBlock, input: {} };
    const delta = isText ? { type: 'text_delta', text: contentBlock.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(contentBlock.input) };
    output += frame('content_block_start', { type: 'content_block_start', index, content_block: initialContent });
    output += frame('content_block_delta', { type: 'content_block_delta', index, delta });
    output += frame('content_block_stop', { type: 'content_block_stop', index });
  }
  return output + frame('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 1 } })
    + frame('message_stop', { type: 'message_stop' });
}

function mainReply(model, counters) {
  counters.mainTurns++;
  if (counters.mainTurns > 2) return completion(model, [{ type: 'text', text: 'fixture-done' }], 10);
  const content = [{ type: 'tool_use', id: `tool_fixture_${counters.mainTurns}`,
    name: 'Agent', input: { subagent_type: 'budget-worker', description: 'Fixture worker', prompt: 'Return fixture-done.' } }];
  const message = completion(model, content, counters.mainTurns === 1 ? 238000 : 240000);
  message.stop_reason = 'tool_use';
  return message;
}

function fixtureReply(body, counters) {
  const model = UPSTREAM_MODELS.includes(body.model) ? body.model : 'other';
  const compact = JSON.stringify(body.system).includes(COMPACT_PROMPT);
  counters.requests++;
  counters.summaryRequests += Number(compact);
  counters.models[model]++;
  if (model !== 'other' && model !== 'codex-auto' && !compact) return mainReply(body.model, counters);
  return completion(body.model, [{ type: 'text', text: 'fixture-done' }], 10);
}

async function serveFixture(request, response, counters) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) throw new Error('fixture request bound');
  }
  const parsed = JSON.parse(body);
  if (/^\/v1\/messages\/count_tokens(?:\?|$)/.test(request.url)) {
    counters.countRequests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ input_tokens: 42 }));
    return;
  }
  const message = fixtureReply(parsed, counters);
  const [contentType, responseBody] = parsed.stream
    ? ['text/event-stream', streamCompletion(message)] : ['application/json', JSON.stringify(message)];
  response.setHeader('content-type', contentType);
  response.end(responseBody);
}

function nonnegativeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function publicTokenCounts(usage, names) {
  return Object.fromEntries(names.filter((name) => nonnegativeTokenCount(usage[name])).map((name) => [name, usage[name]]));
}

function observeContextUsage(usage, counters) {
  if (!UPSTREAM_MODELS.includes(usage.model)) return;
  const counts = publicTokenCounts(usage, ['raw_max_tokens', 'total_tokens', 'percentage']);
  if (!Object.hasOwn(counts, 'raw_max_tokens') || !Object.hasOwn(counts, 'total_tokens')) return;
  if (counters.contextUsage.length >= 32) return;
  counters.contextUsage.push({ model: usage.model, ...counts });
}

function observeUsage(usage, counters) {
  if (!usage || counters.nativeUsage.length >= 32) return;
  const counts = publicTokenCounts(usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
  if (Object.keys(counts).length > 0) counters.nativeUsage.push(counts);
}

function observeAgentAvailability(event, counters) {
  counters.agentAvailable = Array.isArray(event.agents) ? event.agents.includes('budget-worker') : null;
  counters.agentToolAvailable = Array.isArray(event.tools) ? event.tools.includes('Agent') : null;
}

function observeSystem(event, counters) {
  if (event.type !== 'system') return;
  if (event.subtype === 'compact_boundary') counters.compactions++;
  if (event.subtype === 'init') observeAgentAvailability(event, counters);
}

function observeToolResults(content, counters) {
  if (!Array.isArray(content)) return;
  for (const contentBlock of content) {
    if (contentBlock?.type !== 'tool_result') continue;
    counters.toolResults++;
    counters.toolErrors += Number(contentBlock.is_error === true);
    counters.toolRefusals += Number(toolResultRefused(contentBlock));
  }
}

function observeAssistant(event, counters) {
  if (event.type !== 'assistant') return;
  if (event.context_usage) observeContextUsage(event.context_usage, counters);
  observeUsage(event.message?.usage, counters);
}

function observeEvent(line, counters) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  observeSystem(event, counters);
  observeAssistant(event, counters);
  if (event.type === 'result') { counters.completed = event.is_error === false; observeUsage(event.usage, counters); }
  if (event.type === 'user') observeToolResults(event.message?.content, counters);
}

function toolResultRefused(contentBlock) {
  return contentBlock?.type === 'tool_result' && contentBlock.is_error === true
    && /nested|cannot be launched|permission|not allowed/i.test(JSON.stringify(contentBlock.content));
}

function toolResultsRefused(content) {
  if (!Array.isArray(content)) return false;
  return content.some(toolResultRefused);
}

function nativeRefusalLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return false; }
  if (event?.type !== 'user') return false;
  return toolResultsRefused(event.message?.content);
}

function observeWindow(line, counters) {
  const match = line.match(/autocompact:.*tokens=(\d+).*threshold=(\d+).*effectiveWindow=(\d+)/);
  if (!match) return;
  if (counters.windows.length >= 32) return;
  counters.windows.push({ tokens: Number(match[1]), threshold: Number(match[2]), effectiveWindow: Number(match[3]) });
}

async function readWindows(debugPath, counters) {
  if (!fs.existsSync(debugPath)) return;
  if (fs.statSync(debugPath).size > 16 * 1024 * 1024) throw new Error('fixture debug bound');
  const lines = readline.createInterface({ input: fs.createReadStream(debugPath) });
  for await (const line of lines) observeWindow(line, counters);
}

function writeProject(root) {
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
  }));
  fs.writeFileSync(path.join(project, '.claude', 'agents', 'budget-worker.md'),
    '---\nname: budget-worker\ndescription: Synthetic budget compatibility worker\nmodel: codex-auto\ntools: []\n---\nReturn fixture-done.\n');
  return project;
}

function nativeEnvironment(root, port, hostEnvironment) {
  return { ...hostEnvironment, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'fixture-dummy', ANTHROPIC_AUTH_TOKEN: 'fixture-dummy',
    ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
}

function nativeArguments(model, debugPath) {
  return ['--print', '--model', model, '--setting-sources', 'project', '--tools', 'Agent',
    '--output-format', 'stream-json', '--verbose', '--max-turns', '6', '--debug', 'autocompact', '--debug-file', debugPath];
}

function hostBlocked(environment) {
  const controls = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_COMPACT',
    'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'];
  return controls.some((key) => Boolean(environment[key]));
}

function watchDebugBound(root, child) {
  return fs.watch(root, (event, filename) => {
    if (filename !== 'native-debug.log') return;
    const debugPath = path.join(root, filename);
    if (!fs.existsSync(debugPath)) return;
    if (fs.statSync(debugPath).size > 16 * 1024 * 1024) void stopGatewayChild(child);
  });
}

async function removeFixture(root, server, child, debugWatcher) {
  if (debugWatcher) debugWatcher.close();
  if (child) await stopGatewayChild(child);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function runNativeCase({ binary, scratchpad, model, timeout = 120000, launch = spawnGatewayProcess,
  hostEnvironment = process.env, prompt = 'Synthetic fixture only. Run budget-worker twice, then return fixture-done.' }) {
  const root = fs.mkdtempSync(path.join(scratchpad, 'native-budget-'));
  const counters = { requests: 0, countRequests: 0, summaryRequests: 0, mainTurns: 0, compactions: 0,
    models: Object.fromEntries([...UPSTREAM_MODELS, 'other'].map((name) => [name, 0])), windows: [], contextUsage: [], nativeUsage: [],
    agentAvailable: null, agentToolAvailable: null, toolResults: 0, toolErrors: 0, toolRefusals: 0, completed: false };
  let child;
  let timer;
  let debugWatcher;
  let outputBytes = 0;
  let refusal = false;
  let timedOut = false;
  const server = http.createServer((request, response) => {
    serveFixture(request, response, counters).catch(() => { response.writeHead(400); response.end(); });
  });
  try {
    if (hostBlocked(hostEnvironment)) return { status: 'BLOCKED', reason: 'inherited budget override', counters };
    const project = writeProject(root);
    const debugPath = path.join(root, 'native-debug.log');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    child = launch(null, binary, nativeArguments(model, debugPath), {
      cwd: project, env: nativeEnvironment(root, server.address().port, hostEnvironment), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    debugWatcher = watchDebugBound(root, child);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) void stopGatewayChild(child);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      observeEvent(line, counters);
      if (nativeRefusalLine(line)) { refusal = true; void stopGatewayChild(child); }
    });
    child.stderr.on('data', (chunk) => {
      if (/nested|cannot be launched|permission|not allowed/i.test(String(chunk))) {
        refusal = true;
        void stopGatewayChild(child);
      }
    });
    timer = setTimeout(() => { timedOut = true; void stopGatewayChild(child); }, timeout);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const [exitCode] = await once(child, 'close');
    await readWindows(debugPath, counters);
    return { status: refusal ? 'BLOCKED' : 'OBSERVED', exitCode, timedOut, counters };
  } catch {
    return { status: 'UNVERIFIED', reason: 'fixture launch or observation failed', counters };
  } finally {
    clearTimeout(timer);
    await removeFixture(root, server, child, debugWatcher);
  }
}

function windowSeen(result, effectiveWindow, threshold) {
  return result.counters.windows.some((window) => window.effectiveWindow === effectiveWindow && window.threshold === threshold);
}

function contextWindowSeen(result, models, rawMaxTokens) {
  return [result, result.context].filter(nativeObserved).some((run) => run.counters.contextUsage
    .some((usage) => models.includes(usage.model) && usage.raw_max_tokens === rawMaxTokens));
}

function nativeObserved(result) {
  return result?.status === 'OBSERVED' && !result.timedOut && nativeCompleted(result);
}

function nativeCompleted(result) {
  return result.exitCode === 0 && result.counters.completed;
}

function nativeStatus(result, observed) {
  if (result.status !== 'OBSERVED' || result.timedOut) return 'UNVERIFIED';
  if (!nativeCompleted(result)) return 'FAIL';
  return observed ? 'PASS' : 'UNVERIFIED';
}

function recognizedWindowObserved(result) {
  const models = ['claude-opus-5-5[1m]', 'claude-opus-5-5'];
  const window = windowSeen(result, 980000, 967000) || contextWindowSeen(result, models, 1000000);
  const requested = models.some((model) => result.counters.models[model] > 0);
  return window && result.counters.compactions === 0 && requested;
}

function reportCases(custom, recognized) {
  const report = initialReport();
  report.projectEnv.status = nativeStatus(custom, windowSeen(custom, 252000, 239000)
    || contextWindowSeen(custom, ['gpt-6.1-sol'], 272000));
  report.bareMain.status = nativeStatus(custom, custom.counters.models['gpt-6.1-sol'] > 0);
  report.agentFrontmatter.status = nativeStatus(custom, custom.counters.models['codex-auto'] > 0);
  report.proactiveCompaction.status = nativeStatus(custom, custom.counters.compactions > 0 && custom.counters.summaryRequests > 0
    && custom.counters.windows.some((window) => window.threshold === 239000 && window.tokens >= window.threshold));
  report.recognizedClaude.status = nativeStatus(recognized, recognizedWindowObserved(recognized));
  return report;
}

async function runModelCase(options, model) {
  const deadline = Date.now() + 120000;
  const result = await runNativeCase({ ...options, model, timeout: 90000 });
  if (!nativeObserved(result)) return result;
  const remaining = Math.min(30000, deadline - Date.now());
  if (remaining <= 0) return result;
  result.context = await runNativeCase({ ...options, model, prompt: '/context', timeout: remaining });
  if (!nativeObserved(result.context)) result.status = result.context.status === 'BLOCKED' ? 'BLOCKED' : 'UNVERIFIED';
  return result;
}

async function runProbe(options) {
  const custom = await runModelCase(options, MODELS[0]);
  if (custom.status !== 'OBSERVED' || custom.timedOut || custom.exitCode !== 0) {
    return { status: custom.status === 'OBSERVED' ? 'UNVERIFIED' : custom.status, cases: initialReport(), runs: [custom] };
  }
  const recognized = await runModelCase(options, MODELS[2]);
  return { status: recognized.status, cases: reportCases(custom, recognized), runs: [custom, recognized] };
}

async function main() {
  const [binary, scratchpad] = process.argv.slice(2);
  if (!path.isAbsolute(binary || '') || !path.isAbsolute(scratchpad || '')) throw new Error('Supply absolute existing binary and session scratchpad paths');
  const report = await runProbe({ binary, scratchpad });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch(() => { process.stderr.write('Native fixture failed; no compatibility receipt.\n'); process.exitCode = 1; });

module.exports = { initialReport, fixtureReply, streamCompletion, observeEvent, observeWindow, nativeRefusalLine, nativeArguments,
  nativeEnvironment, hostBlocked, runNativeCase, reportCases, runProbe, main };
