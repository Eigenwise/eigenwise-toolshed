'use strict';

const fs = require('node:fs');

const [mode, ...argumentsList] = process.argv.slice(2);
const model = argumentsList[argumentsList.indexOf('--model') + 1];
const debugPath = argumentsList[argumentsList.indexOf('--debug-file') + 1];

async function request(modelName, system = '') {
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', body: JSON.stringify({ model: modelName, system, stream: false }),
  });
  if (response.status !== 200) throw new Error('synthetic request failed');
  return response.json();
}

async function observeSyntheticRun() {
  const first = await request(model);
  await request('codex-auto');
  const second = await request(model);
  await request('codex-auto');
  const recognized = model === 'claude-opus-5-5[1m]';
  const threshold = recognized ? 967000 : 239000;
  const effectiveWindow = recognized ? 980000 : 252000;
  fs.writeFileSync(debugPath, `ignored fixture line\nautocompact: tokens=${first.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\nautocompact: tokens=${second.usage.input_tokens} threshold=${threshold} effectiveWindow=${effectiveWindow}\n`);
  if (!recognized) {
    await request(model, 'You are a helpful AI assistant tasked with summarizing conversations.');
    process.stdout.write('{"type":"system","subtype":"compact_boundary"}\n');
  }
  await request(model);
  process.stdout.write('not-json\n{"type":"result","is_error":false}\n');
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

const modes = { complete: observeSyntheticRun, malformed: malformedRequest, refuse, timeout: waitForever,
  oversizedDebug, oversizedOutput, noObservation };
process.stdin.resume();
process.stdin.once('end', () => {
  Promise.resolve().then(modes[mode]).catch(() => { process.exitCode = 1; });
});
