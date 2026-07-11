'use strict';
/**
 * Tests for the headless drainer (SQ-154): lib/work.js planning + the
 * `sidequest work --dry-run` CLI path.
 *
 * These NEVER spawn `claude` — they exercise planWork() (pure) and the --dry-run
 * command, which compute exactly what WOULD be launched without launching it.
 * The plan must have one entry per wave-1 ready ticket at its capped derived tier.
 *
 * Run: node --test plugins/sidequest/test/work.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-work-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
// Throwaway discovery root (SQ-157/158): getModelPrefs's prefs.custom sources
// from discoverExternalModels(), whose default root is ~/.claude — NOT
// SIDEQUEST_HOME. Point it at an empty dir so a dev box's real
// ~/.claude/codex-gateway/catalog.json (if any) can never leak in here; the
// custom-slug test below seeds its own fake catalog into this same dir.
const DISCOVERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-work-discovery-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY_DIR;
const PROJ = path.join(os.tmpdir(), 'sq-work-fixtures', 'board');
process.env.CLAUDE_PROJECT_DIR = PROJ;

const store = require('../lib/store.js');
const work = require('../lib/work.js');
const { slug } = store.ensureProject(PROJ);

function add(title, complexity, files) {
  return store.createTicket(slug, { title, complexity, complexityWhy: 'seed a ready ticket for the headless drain planning tests', files, source: 'cli' });
}

test('capTier keeps spawnable tiers and folds fable down to opus', () => {
  assert.strictEqual(work.capTier('sonnet'), 'sonnet');
  assert.strictEqual(work.capTier('opus'), 'opus');
  assert.strictEqual(work.capTier('haiku'), 'haiku');
  assert.strictEqual(work.capTier('fable'), 'opus');
});

test('planWork produces one spawn per wave-1 ready ticket, at its derived+capped tier, spawning nothing', () => {
  store.setModelPrefs({ routing: true, opus: true, sonnet: true, haiku: true, fable: true });
  // Two file-disjoint tickets -> same wave; one overlapping -> a later wave.
  const a = add('a', 3, ['src/a.js']);
  const b = add('b', 6, ['src/b.js']);
  add('c', 4, ['src/a.js']); // overlaps a -> wave 2

  const { plan, waveCount } = work.planWork(slug, { max: 5 });
  assert.ok(waveCount >= 2, 'the overlapping ticket forces a second wave');
  const refs = plan.map((p) => p.ref).sort();
  assert.deepStrictEqual(refs, [a.ref, b.ref].sort(), 'wave 1 is the two disjoint tickets');

  for (const p of plan) {
    assert.ok(['opus', 'sonnet', 'haiku'].includes(p.tier), 'tier is a spawnable alias');
    assert.match(p.by, /^headless-sq-\d+-[0-9a-f]{6}$/, 'each run gets a unique worker id');
    // The argv is a real headless invocation carrying the model and JSON output;
    // the (large, multi-line) prompt rides separately, over stdin.
    assert.ok(p.argv.includes('-p'));
    assert.strictEqual(p.argv[p.argv.indexOf('--model') + 1], p.tier);
    assert.ok(p.argv.includes('--output-format') && p.argv.includes('json'));
    assert.ok(!p.argv.some((a) => /ONE ticket/.test(a)), 'the prompt is NOT in argv (it goes over stdin)');
    // The executor brief names the ticket and the claim-first protocol.
    assert.match(p.prompt, new RegExp(`ONE ticket: ${p.ref}`));
    assert.match(p.prompt, /CLAIM FIRST/);
  }
});

test('--max caps the wave-1 batch and records how many were dropped', () => {
  const res = work.planWork(slug, { max: 1 });
  assert.strictEqual(res.plan.length, 1, 'only one run planned');
  assert.ok(res.dropped >= 1, 'the rest of the wave is reported as dropped over --max');
});

test('a fable-derived ticket plans as opus (headless cap)', () => {
  // Enable only fable so every derivation is fable, then confirm the plan caps it.
  store.setModelPrefs({ routing: true, opus: false, sonnet: false, haiku: false, fable: true });
  const t = store.createTicket(slug, { title: 'fable one', complexity: 9, complexityWhy: 'a high-complexity ticket that derives to the fable tier for the cap test', files: ['src/fable-only.js'], source: 'cli' });
  const { plan } = work.planWork(slug, { max: 10 });
  const entry = plan.find((p) => p.ref === t.ref);
  assert.ok(entry, 'the fable ticket is in the plan');
  assert.strictEqual(entry.tier, 'opus', 'fable caps to opus for a spawnable headless model');
  store.setModelPrefs({ routing: true, opus: true, sonnet: true, haiku: true, fable: true });
});

test('permission posture: default acceptEdits, --yolo skips, explicit mode honored', () => {
  const def = work.planWork(slug, { max: 1 }).plan[0];
  assert.ok(def.argv.includes('--permission-mode') && def.argv.includes('acceptEdits'));
  const yolo = work.planWork(slug, { max: 1, yolo: true }).plan[0];
  assert.ok(yolo.argv.includes('--dangerously-skip-permissions'));
  const plan = work.planWork(slug, { max: 1, permissionMode: 'plan' }).plan[0];
  assert.strictEqual(plan.argv[plan.argv.indexOf('--permission-mode') + 1], 'plan');
});

test('the CLI `work --dry-run` prints a plan and spawns no process', () => {
  const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN, 'work', '--dry-run', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.plan), 'dry-run emits a plan array');
  assert.ok(out.plan.length >= 1, 'there is ready work to plan');
  assert.ok(out.plan.every((p) => Array.isArray(p.argv)), 'each plan entry has an argv');
});

test('an empty board plans nothing', () => {
  const empty = store.ensureProject(path.join(os.tmpdir(), 'sq-work-empty', 'board'));
  const { plan } = work.planWork(empty.slug, {});
  assert.deepStrictEqual(plan, []);
});

test('an enabled custom slug spawns uncapped: argv --model is the resolved real id, plan tier stays the slug (SQ-158)', () => {
  // Seed a fake codex-gateway catalog and enable the model it declares — same
  // discovery mechanism SQ-156/157 wire real gateway plugins through.
  fs.mkdirSync(path.join(DISCOVERY_DIR, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(
    path.join(DISCOVERY_DIR, 'codex-gateway', 'catalog.json'),
    JSON.stringify({
      schema: 1,
      source: 'codex-gateway',
      updatedAt: new Date().toISOString(),
      models: [{ slug: 'codex-work-test', id: 'claude-codex-gpt-5.4[1m]', label: 'Codex Test', anchor: 'opus' }],
    }),
  );
  // Anchor it above opus so it dominates a stretch of the ladder — a ticket's
  // model is DERIVED from complexity + the ladder on every read
  // (applyDerivedRouting), so hand-patching t.model directly doesn't stick;
  // the ticket has to actually be complex enough to route here.
  const prefs = store.setModelPrefs({
    routing: true, opus: true, sonnet: true, haiku: true, fable: true,
    customOverrides: {
      'codex-work-test': { enabled: true, offset: 2, efforts: { low: true, medium: true, high: true, xhigh: true, max: true } },
    },
  });
  const ladder = store.routingLadder(prefs);
  const rung = ladder.find((r) => r.model === 'codex-work-test' && r.effort !== 'max');
  assert.ok(rung, 'sanity: the ladder gives the custom a non-max rung at some complexity');

  const created = store.createTicket(slug, {
    title: 'custom-slug ticket', complexity: rung.complexity,
    complexityWhy: 'seed a ticket that derives onto the custom slug for the spawn-resolution test',
    files: ['src/custom-slug-only.js'], source: 'cli',
  });
  // createTicket's own return value is the raw write (model derivation happens
  // at READ time, applyDerivedRouting) — re-fetch to see the derived tier.
  const t = store.getTicket(slug, created.ref);
  assert.strictEqual(t.model, 'codex-work-test', 'the ticket derived onto the custom slug');
  assert.strictEqual(store.resolveModelId('codex-work-test', prefs), 'claude-codex-gpt-5.4[1m]', 'sanity: the slug resolves to the gateway id');

  const { plan } = work.planWork(slug, { max: 10, model: 'codex-work-test' });
  const entry = plan.find((p) => p.ref === t.ref);
  assert.ok(entry, 'the custom-slug ticket is in the plan');
  assert.strictEqual(entry.tier, 'codex-work-test', 'provenance/done stamping keeps the slug, not the resolved id');
  assert.strictEqual(
    entry.argv[entry.argv.indexOf('--model') + 1],
    'claude-codex-gpt-5.4[1m]',
    'the spawned argv --model is the RESOLVED real id, not the slug',
  );
  assert.match(entry.prompt, /--model codex-work-test/, 'the done-command in the prompt still stamps the slug for provenance');

  // Clean up so this doesn't leak into later tests in this file.
  store.setModelPrefs({ customOverrides: { 'codex-work-test': null } });
  fs.rmSync(path.join(DISCOVERY_DIR, 'codex-gateway'), { recursive: true, force: true });
});
