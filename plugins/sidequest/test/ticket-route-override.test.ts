import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sidequestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ticket-route-override-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ticket-route-override-project-'));
const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ticket-route-override-catalog-'));
const catalogDirectory = path.join(discovery, 'model-gateway');
fs.mkdirSync(catalogDirectory, { recursive: true });
fs.writeFileSync(path.join(catalogDirectory, 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' },
    { slug: 'codex-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'Codex Sol' },
  ],
}));
process.env.SIDEQUEST_HOME = sidequestHome;
process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
process.env.CLAUDE_PROJECT_DIR = project;

const store = require('../lib/store.js');
const slug = store.ensureProject(project).slug;

store.setCategory({
  id: 'ticket.override',
  name: 'Ticket override',
  route: { model: 'codex-terra', effort: 'medium' },
  enabled: true,
});

test('a ticket route override prepares its own marker and leaves sibling routing unchanged', () => {
  const overridden = store.createTicket(slug, {
    title: 'Use Sol for this ticket',
    category: 'ticket.override',
    route: { model: 'codex-sol', effort: 'high' },
    source: 'test',
  });
  const sibling = store.createTicket(slug, {
    title: 'Keep the category route',
    category: 'ticket.override',
    source: 'test',
  });

  const overrideDispatch = store.prepareDispatch(slug, overridden.ref, { sessionId: 'ticket-override' });
  const siblingDispatch = store.prepareDispatch(slug, sibling.ref, { sessionId: 'ticket-sibling' });

  assert.deepEqual(overrideDispatch.ticket.dispatch.route, { model: 'codex-sol', effort: 'high', marker: 'gpt-5.6-sol' });
  assert.deepEqual(siblingDispatch.ticket.dispatch.route, { model: 'codex-terra', effort: 'medium', marker: 'gpt-5.6-terra' });
  assert.deepEqual(store.getCategory('ticket.override').route, { model: 'codex-terra', effort: 'medium' });
});

test('an unavailable ticket route override refuses instead of falling back', () => {
  const ticket = store.createTicket(slug, {
    title: 'Refuse an unavailable explicit route',
    category: 'ticket.override',
    route: { model: 'codex-unavailable', effort: 'high' },
    source: 'test',
  });

  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sessionId: 'unavailable-ticket-override' }),
    /route override model "codex-unavailable" isn't currently available; explicit route overrides never fall back/,
  );
  assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, null);
});

function nativeAgent(ticket: any) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'native-agent', ticket.ref, '--project', project, '--unverified-transport', '--json'], {
    encoding: 'utf8',
    env: process.env,
  });
}

test('native-agent applies explicit route override refusals before spawning', () => {
  store.setCategory({
    id: 'ticket.override.claude',
    name: 'Ticket override Claude',
    route: { model: 'sonnet', effort: 'medium' },
    enabled: true,
  });
  const crossing = store.createTicket(slug, {
    title: 'Refuse provider-crossing native agent route',
    category: 'ticket.override.claude',
    route: { model: 'codex-sol', effort: 'high' },
    source: 'test',
  });
  const unavailable = store.createTicket(slug, {
    title: 'Refuse unavailable native agent route',
    category: 'ticket.override',
    route: { model: 'codex-unavailable', effort: 'high' },
    source: 'test',
  });
  const sameProvider = store.createTicket(slug, {
    title: 'Allow same provider native agent route',
    category: 'ticket.override',
    route: { model: 'codex-sol', effort: 'high' },
    source: 'test',
  });

  const crossingResult = nativeAgent(crossing);
  assert.notEqual(crossingResult.status, 0);
  assert.match(crossingResult.stderr, /route override "codex-sol" crosses providers from category "ticket\.override\.claude" and was refused/);

  const unavailableResult = nativeAgent(unavailable);
  assert.notEqual(unavailableResult.status, 0);
  assert.match(unavailableResult.stderr, /route override model "codex-unavailable" isn't currently available; explicit route overrides never fall back/);

  const sameProviderResult = nativeAgent(sameProvider);
  assert.equal(sameProviderResult.status, 0, sameProviderResult.stderr);
  const spawned = JSON.parse(sameProviderResult.stdout);
  assert.equal(spawned.effort, 'high');
  assert.equal(spawned.spawn.subagent_type, 'sidequest-exec-dispatch');
});

export {};
