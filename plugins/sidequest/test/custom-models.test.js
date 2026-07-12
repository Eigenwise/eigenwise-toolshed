'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-grade-routing-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-grade-catalog-'));
const store = require('../lib/store.js');

const GRADES = ['grade-1', 'grade-2', 'grade-3', 'grade-4'];
const PREFS_FILE = path.join(process.env.SIDEQUEST_HOME, 'projects', 'model-prefs.json');

test('routing exposes canonical grade identities', () => {
  assert.deepStrictEqual(store.getModelVocab().models, GRADES);
  assert.strictEqual(store.coerceModel('grade-3'), 'grade-3');
  assert.strictEqual(store.coerceModel('opus'), 'grade-3');
  assert.strictEqual(store.coerceModel('complex'), 'grade-3');
  assert.strictEqual(store.classifyModelFilter('fable'), 'grade-4');
});

test('legacy provider, profile, effort and backend prefs migrate losslessly', () => {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify({
    haiku: false, sonnet: true, opus: true, fable: false,
    efforts: { sonnet: { low: false }, opus: { xhigh: false }, fable: { max: false } },
    tierBackend: { opus: 'codex-gpt-5-6-terra' }, routingBias: 2,
  }));
  const prefs = store.getModelPrefs();
  assert.strictEqual(prefs['grade-1'], false);
  assert.strictEqual(prefs['grade-2'], true);
  assert.strictEqual(prefs['grade-3'], true);
  assert.strictEqual(prefs['grade-4'], false);
  assert.strictEqual(prefs.efforts['grade-2'].low, false);
  assert.strictEqual(prefs.efforts['grade-3'].xhigh, false);
  assert.strictEqual(prefs.tierBackend['grade-3'], 'codex-gpt-5-6-terra');
  assert.strictEqual(prefs.routingBias, 2);
  const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw).filter((k) => /^grade-/.test(k)), GRADES);
  for (const old of ['haiku', 'sonnet', 'opus', 'fable', 'routine', 'everyday', 'complex', 'frontier']) assert.ok(!(old in raw), old + ' must not persist');
  assert.deepStrictEqual(Object.keys(raw.efforts).sort(), ['grade-2', 'grade-3', 'grade-4']);
  assert.deepStrictEqual(Object.keys(raw.tierBackend).sort(), GRADES);
});

test('grade prefs round-trip and routing only emits grades', () => {
  const saved = store.setModelPrefs({
    'grade-2': false,
    efforts: { 'grade-3': { high: false } },
    tierBackend: { 'grade-4': 'claude' },
  });
  assert.strictEqual(saved['grade-2'], false);
  assert.strictEqual(saved.efforts['grade-3'].high, false);
  for (const rung of store.routingLadder(saved)) assert.ok(GRADES.includes(rung.model));
  const ticket = store.applyDerivedRouting({ complexity: 6 }, saved);
  assert.ok(GRADES.includes(ticket.model));
  assert.strictEqual(ticket.profile, ticket.model);
});

test('deprecated aliases are accepted but canonical output stays grade-keyed', () => {
  const saved = store.setModelPrefs({ profiles: { complex: { enabled: false, efforts: { low: false } } }, tierBackend: { frontier: 'claude' } });
  assert.strictEqual(saved['grade-3'], false);
  assert.strictEqual(saved.efforts['grade-3'].low, false);
  const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  assert.ok(!('profiles' in raw));
  assert.ok(!('complex' in raw.tierBackend));
});
