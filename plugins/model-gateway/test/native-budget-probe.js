'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { spawnGatewayProcess, stopGatewayChild } = require('./support.js');

const MODELS = ['gpt-6.1-sol', 'codex-auto', 'claude-opus-5-5[1m]'];
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
  const model = MODELS.includes(body.model) ? body.model : 'other';
  const compact = JSON.stringify(body.system).includes(COMPACT_PROMPT);
  counters.requests++;
  counters.summaryRequests += Number(compact);
  counters.models[model]++;
  if (model !== 'codex-auto' && !compact) return mainReply(body.model, counters);
  return completion(body.model, [{ type: 'text', text: 'fixture-done' }], 10);
}

async function serveFixture(request, response, counters) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) throw new Error('fixture request bound');
  }
  const parsed = JSON.parse(body);
  const message = fixtureReply(parsed, counters);
  response.setHeader('content-type', parsed.stream ? 'text/event-stream' : 'application/json');
  response.end(parsed.stream ? streamCompletion(message) : JSON.stringify(message));
}

function observeEvent(line, counters) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'system' && event.subtype === 'compact_boundary') counters.compactions++;
  if (event.type === 'result') counters.completed = event.is_error === false;
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
  const controls = ['CLAUDECODE', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
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

async function runNativeCase({ binary, scratchpad, model, timeout = 120000, launch = spawnGatewayProcess, hostEnvironment = process.env }) {
  const root = fs.mkdtempSync(path.join(scratchpad, 'native-budget-'));
  const counters = { requests: 0, summaryRequests: 0, mainTurns: 0, compactions: 0,
    models: Object.fromEntries([...MODELS, 'other'].map((name) => [name, 0])), windows: [], completed: false };
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
    if (hostBlocked(hostEnvironment)) return { status: 'BLOCKED', reason: 'native guard or inherited budget override', counters };
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
    lines.on('line', (line) => observeEvent(line, counters));
    child.stderr.on('data', (chunk) => {
      if (/nested|cannot be launched|permission|not allowed/i.test(String(chunk))) refusal = true;
    });
    timer = setTimeout(() => { timedOut = true; void stopGatewayChild(child); }, timeout);
    child.stdin.on('error', () => {});
    child.stdin.end('Synthetic fixture only. Run budget-worker twice, then return fixture-done.');
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

function nativeCompleted(result) {
  return result.exitCode === 0 && result.counters.completed;
}

function nativeStatus(result, observed) {
  if (result.status !== 'OBSERVED' || result.timedOut) return 'UNVERIFIED';
  if (!nativeCompleted(result)) return 'FAIL';
  return observed ? 'PASS' : 'UNVERIFIED';
}

function reportCases(custom, recognized) {
  const report = initialReport();
  report.projectEnv.status = nativeStatus(custom, windowSeen(custom, 252000, 239000));
  report.bareMain.status = nativeStatus(custom, custom.counters.models['gpt-6.1-sol'] > 0);
  report.agentFrontmatter.status = nativeStatus(custom, custom.counters.models['codex-auto'] > 0);
  report.proactiveCompaction.status = nativeStatus(custom, custom.counters.compactions > 0 && custom.counters.summaryRequests > 0
    && custom.counters.windows.some((window) => window.threshold === 239000 && window.tokens >= window.threshold));
  report.recognizedClaude.status = nativeStatus(recognized, windowSeen(recognized, 980000, 967000)
    && recognized.counters.compactions === 0 && recognized.counters.models['claude-opus-5-5[1m]'] > 0);
  return report;
}

async function runProbe(options) {
  const custom = await runNativeCase({ ...options, model: MODELS[0] });
  if (custom.status !== 'OBSERVED' || custom.timedOut || custom.exitCode !== 0) {
    return { status: custom.status === 'OBSERVED' ? 'UNVERIFIED' : custom.status, cases: initialReport(), runs: [custom] };
  }
  const recognized = await runNativeCase({ ...options, model: MODELS[2] });
  return { status: recognized.status, cases: reportCases(custom, recognized), runs: [custom, recognized] };
}

async function main() {
  const [binary, scratchpad] = process.argv.slice(2);
  if (!path.isAbsolute(binary || '') || !path.isAbsolute(scratchpad || '')) throw new Error('Supply absolute existing binary and session scratchpad paths');
  const report = await runProbe({ binary, scratchpad });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch(() => { process.stderr.write('Native fixture failed; no compatibility receipt.\n'); process.exitCode = 1; });

module.exports = { initialReport, fixtureReply, streamCompletion, observeEvent, observeWindow, nativeArguments,
  nativeEnvironment, hostBlocked, runNativeCase, reportCases, runProbe, main };
