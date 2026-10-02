'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

const [mode, ...argumentsList] = process.argv.slice(2);
const model = argumentsList[argumentsList.indexOf('--model') + 1];
const debugPath = argumentsList[argumentsList.indexOf('--debug-file') + 1];
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function complete() {
  const sessionIds = { noSession: undefined, invalidSession: '../fixture-secret' };
  const sessionId = Object.hasOwn(sessionIds, mode) ? sessionIds[mode] : SESSION_ID;
  emit({ type: 'result', subtype: 'success', num_turns: 3, is_error: false, permission_denials: [],
    session_id: sessionId, result: 'fixture-secret-result' });
}

async function request(modelName, system = '') {
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', body: JSON.stringify({ model: modelName, system, stream: false,
      tools: [{ name: 'Task', input_schema: { type: 'object', properties: {
        subagent_type: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' },
      }, required: ['description', 'prompt'] } }] }),
  });
  if (response.status !== 200) throw new Error('synthetic request failed');
  return response.json();
}

function observeWorker(toolUseId) {
  emit({ type: 'system', subtype: 'task_started', tool_use_id: toolUseId, task_id: 'fixture-secret-task', description: 'fixture-secret' });
  emit({ type: 'assistant', parent_tool_use_id: toolUseId, message: { model: 'codex-auto', content: 'fixture-secret' } });
}

function writeSyntheticWindow(first, second, recognized) {
  if (mode === 'metadataOnly') return;
  const threshold = recognized ? 967000 : 239000;
  const effectiveWindow = recognized ? 980000 : 252000;
  fs.writeFileSync(debugPath, `ignored fixture line\nautocompact: tokens=${first.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\nautocompact: tokens=${second.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\n`);
}

async function observeSyntheticRun() {
  const upstreamModel = model.replace('[1m]', '');
  emit({ type: 'system', subtype: 'init', agents: ['budget-worker'], tools: ['Task'] });
  const first = await request(upstreamModel);
  observeWorker(first.content[0].id);
  await request('codex-auto');
  const second = await request(upstreamModel);
  assert.equal(first.content[0].name, 'Task', 'synthetic client consumes its advertised Task schema');
  assert.equal(second.content[0].name, 'Task');
  observeWorker(second.content[0].id);
  await request('codex-auto');
  const recognized = model === 'claude-opus-5-5[1m]';
  writeSyntheticWindow(first, second, recognized);
  if (!recognized) {
    await request(upstreamModel, 'You are a helpful AI assistant tasked with summarizing conversations.');
    const compactMetadata = mode === 'metadataOnly' ? undefined : { trigger: 'auto', pre_tokens: 240000, secret: 'fixture-secret' };
    emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: compactMetadata });
  }
  await request(upstreamModel);
  emit({ type: 'assistant', message: { usage: second.usage } });
  process.stdout.write('not-json\n');
  complete();
}

function structuralDenial() {
  if (mode === 'refuseContext') return refuseTool();
  if (mode.startsWith('resultDenial')) emit({ type: 'result', subtype: 'success', num_turns: 1, is_error: false,
    session_id: SESSION_ID, permission_denials: [{ tool_name: 'fixture-secret', tool_input: { secret: 'fixture-secret' } }] });
  else emit({ type: 'system', subtype: 'permission_denied', tool_name: 'fixture-secret', message: 'fixture-secret' });
  waitForever();
}

async function observeSyntheticContext() {
  if (['refuseContext', 'systemDenialContext', 'resultDenialContext'].includes(mode)) return structuralDenial();
  if (['noSession', 'invalidSession'].includes(mode)) assert.equal(argumentsList.includes('--resume'), false);
  else assert.equal(argumentsList[argumentsList.indexOf('--resume') + 1], SESSION_ID, 'context resumes only the fixture result session');
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages/count_tokens?beta=true`, {
    method: 'POST', body: JSON.stringify({ model: model.replace('[1m]', ''), messages: [] }),
  });
  const count = await response.json();
  if (count.input_tokens !== 42) throw new Error('synthetic count protocol mismatch');
  const usage = { model, raw_max_tokens: model === 'gpt-6.1-sol' ? 272000 : 1000000,
    total_tokens: 42, percentage: 0.125, over_limit: { kind: 'compaction_window', tokens_over: 2, secret: 'fixture-secret' },
    categories: [{ synthetic: 'must not escape' }], memory_files: [{ path: 'fixture-secret' }] };
  emit({ type: 'assistant', context_usage: usage });
  complete();
}

async function malformedRequest() {
  await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: 'bad' });
  await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  const streamed = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', body: JSON.stringify({ model: 'codex-auto', system: '', stream: true }),
  });
  if (!(await streamed.text()).includes('event: message_stop')) throw new Error('synthetic stream incomplete');
  emit({ type: 'result', is_error: true });
}

async function httpObservation() {
  for (const [method, endpoint] of [['GET', 'models?fixture-secret'], ['GET', 'models/fixture-secret'], ['GET', 'messages/count_tokens'], ['DELETE', 'fixture-secret'], ['POST', 'messages']]) {
    const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/${endpoint}`, { method });
    assert.equal(response.status, 400, 'unparseable requests preserve existing fixture response');
  }
  complete();
}

function refuse() {
  process.stderr.write('Cannot be launched: native permission refusal\n');
  process.exitCode = 7;
}

function refuseTool() {
  emit({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission denied for Agent' }] } });
  waitForever();
}

function waitForever() {
  setInterval(() => process.stdout.write('waiting\n'), 20);
}

function oversizedDebug() {
  fs.writeFileSync(debugPath, 'x'.repeat(16 * 1024 * 1024 + 1));
  waitForever();
}

function oversizedOutput() {
  process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  waitForever();
}

function noObservation() {
  emit({ type: 'result', is_error: false });
}

const modes = { complete: observeSyntheticRun, metadataOnly: observeSyntheticRun, refuseContext: observeSyntheticRun,
  noSession: observeSyntheticRun, invalidSession: observeSyntheticRun, resultDenialContext: observeSyntheticRun, systemDenialContext: observeSyntheticRun,
  resultDenial: structuralDenial, systemDenial: structuralDenial, httpObservation,
  malformed: malformedRequest, refuse, refuseTool, timeout: waitForever, oversizedDebug, oversizedOutput, noObservation };
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.once('end', () => {
  Promise.resolve().then(prompt === '/context' ? observeSyntheticContext : modes[mode]).catch(() => { process.exitCode = 1; });
});
