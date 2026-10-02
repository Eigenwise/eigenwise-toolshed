'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

const [mode, ...argumentsList] = process.argv.slice(2);
const model = argumentsList[argumentsList.indexOf('--model') + 1];
const debugPath = argumentsList[argumentsList.indexOf('--debug-file') + 1];

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

async function observeSyntheticRun() {
  const upstreamModel = model.replace('[1m]', '');
  process.stdout.write('{"type":"system","subtype":"init","agents":["budget-worker"],"tools":["Task"]}\n');
  const first = await request(upstreamModel);
  await request('codex-auto');
  const second = await request(upstreamModel);
  assert.equal(first.content[0].name, 'Task', 'synthetic client consumes its advertised Task schema');
  assert.equal(second.content[0].name, 'Task');
  await request('codex-auto');
  const recognized = model === 'claude-opus-5-5[1m]';
  const threshold = recognized ? 967000 : 239000;
  const effectiveWindow = recognized ? 980000 : 252000;
  if (mode !== 'metadataOnly') fs.writeFileSync(debugPath, `ignored fixture line\nautocompact: tokens=${first.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\nautocompact: tokens=${second.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\n`);
  if (!recognized) {
    await request(upstreamModel, 'You are a helpful AI assistant tasked with summarizing conversations.');
    process.stdout.write('{"type":"system","subtype":"compact_boundary"}\n');
  }
  await request(upstreamModel);
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { usage: second.usage } })}\n`);
  process.stdout.write('not-json\n{"type":"result","is_error":false}\n');
}

async function observeSyntheticContext() {
  if (mode === 'refuseContext') return refuseTool();
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages/count_tokens?beta=true`, {
    method: 'POST', body: JSON.stringify({ model: model.replace('[1m]', ''), messages: [] }),
  });
  const count = await response.json();
  if (count.input_tokens !== 42) throw new Error('synthetic count protocol mismatch');
  const usage = { model, raw_max_tokens: model === 'gpt-6.1-sol' ? 272000 : 1000000,
    total_tokens: 42, percentage: 0, categories: [{ synthetic: 'must not escape' }], memory_files: [{ path: 'fixture-secret' }] };
  process.stdout.write(`${JSON.stringify({ type: 'assistant', context_usage: usage })}\n`);
  process.stdout.write('{"type":"result","is_error":false}\n');
}

async function malformedRequest() {
  await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: 'bad' });
  await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  const streamed = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', body: JSON.stringify({ model: 'codex-auto', system: '', stream: true }),
  });
  if (!(await streamed.text()).includes('event: message_stop')) throw new Error('synthetic stream incomplete');
  process.stdout.write('{"type":"result","is_error":true}\n');
}

function refuse() {
  process.stderr.write('Cannot be launched: native permission refusal\n');
  process.exitCode = 7;
}

function refuseTool() {
  process.stdout.write('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"Permission denied for Agent"}]}}\n');
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
  process.stdout.write('{"type":"result","is_error":false}\n');
}

const modes = { complete: observeSyntheticRun, metadataOnly: observeSyntheticRun, refuseContext: observeSyntheticRun,
  malformed: malformedRequest, refuse, refuseTool, timeout: waitForever, oversizedDebug, oversizedOutput, noObservation };
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.once('end', () => {
  Promise.resolve().then(prompt === '/context' ? observeSyntheticContext : modes[mode]).catch(() => { process.exitCode = 1; });
});
