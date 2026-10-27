'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const producerRoot = path.resolve(__dirname, '../../observability');
const consumers = ['toolshed-doctor', 'setup'].map((name) => ({
  name,
  text: fs.readFileSync(path.join(__dirname, '../skills', name, 'SKILL.md'), 'utf8'),
}));
const hooks = JSON.parse(fs.readFileSync(path.join(producerRoot, 'hooks/hooks.json'), 'utf8'));
const hookSources = hooks.modules.map((modulePath) => {
  const filename = path.join(producerRoot, 'hooks', modulePath);
  assert.ok(fs.existsSync(filename), `registered hook module exists: ${modulePath}`);
  return fs.readFileSync(filename, 'utf8');
}).join('\n');
const skillNames = fs.readdirSync(path.join(producerRoot, 'skills')).map((directory) => {
  const text = fs.readFileSync(path.join(producerRoot, 'skills', directory, 'SKILL.md'), 'utf8');
  return text.match(/^name:\s*(\S+)/m)[1];
});
const registeredCommands = [...hookSources.matchAll(/command\.register\(\{\s*name:\s*['"]([^'"]+)/g)]
  .map((match) => match[1]);

function assertProducerPaths(text) {
  const references = [...text.matchAll(/(?:<OBS_ROOT>\/|plugins\/observability\/)([\w./-]+)/g)];
  for (const reference of references) {
    assert.ok(fs.existsSync(path.join(producerRoot, reference[1])), `Observability file exists: ${reference[1]}`);
  }
  return references.length;
}

function assertProducerCommands(text) {
  const references = [...text.matchAll(/\/observability:([\w-]+)/g)];
  for (const reference of references) {
    assert.ok([...skillNames, ...registeredCommands].includes(reference[1]), `Observability command exists: ${reference[1]}`);
  }
  return references.length;
}

for (const consumer of consumers) {
  test(`${consumer.name} names only existing Observability files and commands`, () => {
    assertProducerPaths(consumer.text);
    assert.ok(assertProducerCommands(consumer.text) > 0, 'consumer names the current Observability commands');
  });
}

test('doctor references actual producer files and the registered status reader', () => {
  assert.ok(assertProducerPaths(consumers[0].text) > 0, 'doctor points to the producer implementing the checks');
  assert.match(hookSources, /command:\s*'track'/);
  assert.match(hookSources, /store\.get\(trackKey\(project\)\)/);
  assert.match(hookSources, /`track:\$\{project\.root\}`/);
  assert.match(consumers[0].text, /\/observability:track status/);
  assert.match(consumers[0].text, /track:<project\.root>/);
});

test('consumer validation rejects future missing file and command references', () => {
  assert.throws(() => assertProducerPaths(consumers[0].text.replace('hooks/register.ts', 'hooks/renamed-reader.ts')), /Observability file exists: hooks\/renamed-reader.ts/);
  assert.throws(() => assertProducerCommands(consumers[1].text.replace('/observability:board', '/observability:renamed-board')), /Observability command exists: renamed-board/);
});

test('doctor keeps registry discovery separate from recording and history', () => {
  const doctor = consumers[0].text;
  assert.match(doctor, /observability@eigenwise-toolshed/);
  assert.match(doctor, /Do not require a particular plugin file/);
  assert.match(doctor, /Do not infer consent\s+from an existing ledger/);
  assert.match(doctor, /recording state as unknown/);
  assert.match(doctor, /project is not opted in/);
});

test('doctor describes read-only ledger and board checks without retired services', () => {
  const doctor = consumers[0].text;
  assert.match(doctor, /observability\/ledger\/<project-slug>\.jsonl/);
  assert.match(doctor, /byte size/);
  assert.match(doctor, /newest valid row's `at`/);
  assert.match(doctor, /malformed rows or unreadable/);
  assert.match(doctor, /observability\/board\.html/);
  assert.match(doctor, /do not run that command during this read-only check/);
  for (const consumer of consumers) {
    assert.doesNotMatch(consumer.text, /\b(?:Docker|Collector|Grafana|outbox|sinks?)\b/i);
  }
});
