'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-grade-routing-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-grade-catalog-'));
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const database = db.openDb(store.homeRoot());

const GRADES = ['grade-1', 'grade-2', 'grade-3', 'grade-4'];

test('routing exposes canonical grade identities', () => {
  assert.deepStrictEqual(store.getModelVocab().models, GRADES);
  assert.strictEqual(store.coerceModel('grade-3'), 'grade-3');
  assert.strictEqual(store.coerceModel('opus'), 'grade-3');
  assert.strictEqual(store.coerceModel('complex'), 'grade-3');
  assert.strictEqual(store.classifyModelFilter('fable'), 'grade-4');
});

test('legacy provider, profile, effort and backend prefs migrate losslessly', () => {
  db.putRow(database, 'globals', { key: 'model-prefs', data: {
    haiku: false, sonnet: true, opus: true, fable: false,
    efforts: { sonnet: { low: false }, opus: { xhigh: false }, fable: { max: false } },
    tierBackend: { opus: 'codex-gpt-5-6-terra' }, routingBias: 2,
  }});
  const prefs = store.getModelPrefs();
  assert.strictEqual(prefs['grade-1'], false);
  assert.strictEqual(prefs['grade-2'], true);
  assert.strictEqual(prefs['grade-3'], true);
  assert.strictEqual(prefs['grade-4'], false);
  assert.strictEqual(prefs.efforts['grade-2'].low, false);
  assert.strictEqual(prefs.efforts['grade-3'].xhigh, false);
  assert.strictEqual(prefs.tierBackend['grade-3'], 'codex-gpt-5-6-terra');
  assert.strictEqual(prefs.routingBias, 2);
  const raw = db.getRow(database, 'globals', 'model-prefs');
  assert.deepStrictEqual(Object.keys(raw).filter((k) => /^grade-/.test(k)), GRADES);
  for (const old of ['haiku', 'sonnet', 'opus', 'fable', 'routine', 'everyday', 'complex', 'frontier']) assert.ok(!(old in raw), old + ' must not persist');
  assert.deepStrictEqual(Object.keys(raw.efforts).sort(), ['grade-1', 'grade-2', 'grade-3', 'grade-4']);
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
  const raw = db.getRow(database, 'globals', 'model-prefs');
  assert.ok(!('profiles' in raw));
  assert.ok(!('complex' in raw.tierBackend));
});

test('explicit Claude runtime assignments resolve to the chosen Agent model and effort availability', () => {
  const saved = store.setModelPrefs({
    tierBackend: { 'grade-1': 'opus', 'grade-2': 'haiku', 'grade-3': 'fable' },
  });
  assert.deepStrictEqual(saved.tierBackend, {
    'grade-1': 'opus', 'grade-2': 'haiku', 'grade-3': 'fable', 'grade-4': 'claude',
  });
  assert.deepStrictEqual(saved.tierBackendWarnings, []);

  const grade1 = store.resolveExec('grade-1', 'high', saved);
  assert.deepStrictEqual({ model: grade1.model, spawnId: grade1.spawnId, runsModel: grade1.runsModel, runsLabel: grade1.runsLabel }, {
    model: 'opus', spawnId: 'opus', runsModel: 'opus', runsLabel: 'Claude Opus',
  });
  assert.strictEqual(grade1.agent, 'sidequest-exec-high');
  assert.deepStrictEqual(store.resolveExec('grade-2', 'high', saved), {
    agent: null, model: 'haiku', spawnId: 'haiku', backend: 'claude', slug: 'haiku', runsModel: 'haiku', runsLabel: 'Claude Haiku', dispatch: 'native-agent',
  });
  const grade3 = store.resolveExec('grade-3', 'high', saved);
  assert.strictEqual(grade3.model, 'fable');
  assert.strictEqual(grade3.runsLabel, 'Claude Fable');

  const profiles = saved.profiles;
  assert.ok(profiles['grade-1'].efforts, 'explicit Opus enables Grade 1 effort selection');
  assert.strictEqual(profiles['grade-2'].efforts, null, 'explicit Haiku has no effort selection');
  assert.ok(profiles['grade-3'].efforts, 'explicit Fable keeps effort selection');
});

test('an effort-capable Codex runtime named haiku keeps its effort axis', () => {
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-codex-haiku-'));
  fs.mkdirSync(path.join(catalogDir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalogDir, 'codex-gateway', 'catalog.json'), JSON.stringify({
    schema: 2,
    source: 'codex-gateway',
    updatedAt: new Date().toISOString(),
    models: [{ slug: 'haiku', id: 'claude-codex-haiku', label: 'Codex Haiku' }],
  }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalogDir;

  const saved = store.setModelPrefs({ tierBackend: { 'grade-2': 'codex-gateway:haiku' } });
  assert.ok(saved.profiles['grade-2'].efforts, 'Codex runtime retains Grade 2 effort selection');
  const exec = store.resolveExec('grade-2', 'high', saved);
  assert.strictEqual(exec.backend, 'codex');
  assert.strictEqual(exec.agent, 'sidequest-exec-haiku-high');
});
