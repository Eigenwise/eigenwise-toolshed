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
  updatedAt: new Date().toISOString(),
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
const mcp = require('../lib/mcp.js');
const slug = store.ensureProject(project).slug;

store.setCategory({
  id: 'ticket.override',
  name: 'Ticket override',
  route: { model: 'codex-terra', effort: 'medium' },
  enabled: true,
});

function tool(name: string) {
  const found = mcp.TOOLS.find((candidate: any) => candidate.name === name);
  assert.ok(found, `${name} is exposed over MCP`);
  return found;
}

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

  const overrideDispatch = store.prepareDispatch(slug, overridden.ref, { allowUnscoped: true, sessionId: 'ticket-override' });
  const siblingDispatch = store.prepareDispatch(slug, sibling.ref, { allowUnscoped: true, sessionId: 'ticket-sibling' });

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
    () => store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId: 'unavailable-ticket-override' }),
    /route override model "codex-unavailable" isn't currently available; explicit route overrides never fall back/,
  );
  assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, null);
});

test('an unavailable readonly cross-provider override still refuses', () => {
  store.setCategory({
    id: 'ticket.override.readonly-unavailable',
    name: 'Readonly unavailable override',
    route: { model: 'sonnet', effort: 'medium' },
    readonly: true,
    enabled: true,
  });
  const ticket = store.createTicket(slug, {
    title: 'Refuse unavailable readonly cross-provider route',
    category: 'ticket.override.readonly-unavailable',
    route: { model: 'codex-unavailable', effort: 'high' },
    source: 'test',
  });

  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId: 'unavailable-readonly-cross-provider' }),
    /route override model "codex-unavailable" isn't currently available; explicit route overrides never fall back/,
  );
});

test('effective readonly state controls cross-provider routes through add and update', async () => {
  const route = { model: 'codex-sol', effort: 'high' };
  const cases = [
    { categoryReadonly: false, readonly: true, operation: 'add', allowed: true },
    { categoryReadonly: true, readonly: true, operation: 'update', allowed: true },
    { categoryReadonly: false, readonly: false, operation: 'update', allowed: false },
    { categoryReadonly: true, readonly: false, operation: 'add', allowed: false },
    { categoryReadonly: false, readonly: undefined, operation: 'add', allowed: false },
    { categoryReadonly: true, readonly: undefined, operation: 'update', allowed: true },
  ];

  for (const [index, testCase] of cases.entries()) {
    const category = `ticket.override.readonly-${index}`;
    store.setCategory({
      id: category,
      name: `Readonly override ${index}`,
      route: { model: 'sonnet', effort: 'medium' },
      readonly: testCase.categoryReadonly,
      enabled: true,
    });
    const created = await tool('add').handler({
      project,
      title: `Override ${index}`,
      category,
      ...(testCase.readonly === undefined ? {} : { readonly: testCase.readonly }),
      ...(testCase.operation === 'add' ? { route } : {}),
    });
    if (testCase.operation === 'update') {
      await tool('update').handler({ project, ref: created.ref, route });
    }

    const ticket = store.getTicket(slug, created.ref);
    assert.equal(ticket.readonlyOverride, testCase.readonly ?? null, `case ${index} keeps its explicit readonly override`);
    if (!testCase.allowed) {
      assert.throws(
        () => store.prepareDispatch(slug, created.ref, { allowUnscoped: true, sessionId: `readonly-refusal-${index}` }),
        /route override "codex-sol" crosses providers from category/,
      );
      continue;
    }

    const prepared = store.prepareDispatch(slug, created.ref, { allowUnscoped: true, sessionId: `readonly-override-${index}` });
    assert.deepEqual(prepared.ticket.dispatch.route, { model: 'codex-sol', effort: 'high', marker: 'gpt-5.6-sol' });
    assert.equal(prepared.ticket.dispatch.readonly, true);
    assert.equal(prepared.ticket.dispatch.executor, 'sidequest-exec-dispatch-readonly');
    assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-dispatch-readonly');
  }
});

test('automatic fallbacks still refuse provider crossings', () => {
  store.setCategory({
    id: 'ticket.override.fallback',
    name: 'Fallback provider boundary',
    route: { model: 'codex-unavailable', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });

  const resolved = store.resolveCategoryRoute(store.getCategory('ticket.override.fallback'));

  assert.equal(resolved.exec, null);
  assert.match(resolved.warnings.join('\n'), /category fallback route "sonnet" crosses providers and was refused/);

  store.setCategory({
    id: 'ticket.override.global-fallback',
    name: 'Global fallback provider boundary',
    route: { model: 'codex-unavailable', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  const globalResolved = store.resolveCategoryRoute(store.getCategory('ticket.override.global-fallback'));

  assert.equal(globalResolved.exec, null);
  assert.match(globalResolved.warnings.join('\n'), /global fallback route "sonnet" crosses providers and was refused/);
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
  assert.equal(spawned.spawn.subagent_type, 'sidequest:sidequest-exec-dispatch');
});

export {};
