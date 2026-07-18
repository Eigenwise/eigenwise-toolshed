'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-switchboard-adoption-'));
const discoveryRoot = path.join(sandbox, 'discovery');
const switchboardRoot = path.join(sandbox, 'switchboard');
const projectRoot = path.join(sandbox, 'project');
const userConfig = path.join(sandbox, 'config', 'user.json');
const projectConfig = path.join(sandbox, 'config', 'project.json');

fs.mkdirSync(path.join(discoveryRoot, 'toolshed', 'registry'), { recursive: true });
fs.mkdirSync(path.join(switchboardRoot, 'bin'), { recursive: true });
fs.mkdirSync(path.join(switchboardRoot, 'lib'), { recursive: true });
fs.mkdirSync(path.join(switchboardRoot, 'dashboard'), { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(switchboardRoot, 'lib', 'contract.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(switchboardRoot, 'lib', 'mcp.js'), `
const category = { id: 'general', name: 'General', description: 'General work.', contract: 'Work the task.', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true };
const routed = (id) => ({ contractVersion: 1, status: 'routed', category: { id, contract: category.contract }, route: { model: 'sonnet', effort: 'high', source: 'primary' }, dispatch: { kind: 'native', spawnModel: 'sonnet' }, attempts: [], warnings: [] });
module.exports = {
  listCategories: ({ global } = {}) => ({ schemaVersion: 1, scope: global ? 'global' : 'effective', categories: [category], states: { general: 'inherited' }, warnings: [] }),
  availableModels: () => ({ catalogSchemaVersion: 3, status: 'available', models: [{ model: 'sonnet', label: 'Claude Sonnet', available: true }], warnings: [] }),
  getFallback: () => ({ fallback: { model: 'sonnet', effort: 'high' } }),
  doctor: () => ({ ok: true }),
  resolve: ({ categoryId }) => routed(categoryId),
  editCategory: () => ({ category }),
  detachCategory: () => ({ category }),
  relinkCategory: () => ({ category }),
  disableCategory: () => ({ category }),
  setFallback: ({ route }) => ({ fallback: route })
};
`);
fs.writeFileSync(path.join(switchboardRoot, 'dashboard', 'panel.js'), 'window.SwitchboardPanel = { createPanel: function () {} };\n');
fs.writeFileSync(path.join(switchboardRoot, 'bin', 'switchboard.js'), `
const requestIndex = process.argv.indexOf('--request');
const request = JSON.parse(process.argv[requestIndex + 1]);
const model = process.env.SQ_FAKE_SWITCHBOARD_MODEL || 'sonnet';
process.stdout.write(JSON.stringify({
  contractVersion: 1,
  status: 'routed',
  category: { id: request.categoryId, contract: 'Fixture contract.' },
  route: { model, effort: 'high', source: 'primary' },
  dispatch: { kind: 'native', spawnModel: model },
  attempts: [],
  warnings: []
}));
`);
fs.writeFileSync(path.join(discoveryRoot, 'toolshed', 'registry', 'switchboard.json'), JSON.stringify({
  schemaVersion: 1,
  name: 'switchboard',
  version: '0.10.0',
  root: switchboardRoot,
  capabilities: ['routing', 'categories'],
  routing: { contractVersion: 1, command: 'bin/switchboard.js routing resolve --request <json>', adapter: 'lib/contract.js' },
  ui: { contractVersion: 1, panels: [{ id: 'routing', label: 'Routing', entry: 'dashboard/panel.js', capability: 'routing' }] },
}));

process.env.SIDEQUEST_HOME = path.join(sandbox, 'sidequest-home');
process.env.SIDEQUEST_DISCOVERY_DIRS = discoveryRoot;
process.env.SWITCHBOARD_CONFIG_USER_FILE = userConfig;
process.env.SWITCHBOARD_CONFIG_PROJECT_FILE = projectConfig;
process.env.SIDEQUEST_SWITCHBOARD_CACHE_MS = '0';
process.env.SIDEQUEST_NO_HOT_RECYCLE = '1';

const discovery = require('../lib/discovery.js');
const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const server = require('../lib/server.js');

const project = store.ensureProject(projectRoot).slug;
const general = store.setCategory({
  id: 'general',
  name: 'General',
  description: 'General work.',
  contract: 'Work the task.',
  route: { model: 'sonnet', effort: 'high' },
  fallback: null,
  enabled: true,
});

test('comparison mode records mismatches but keeps Sidequest authoritative', () => {
  process.env.SQ_FAKE_SWITCHBOARD_MODEL = 'opus';
  discovery.clearSwitchboardCache();
  const ticket = store.applyDerivedRouting({ category: 'general' }, { project });
  assert.equal(ticket.model, 'sonnet');
  assert.equal(ticket.effort, 'high');
  const comparison = store.compareSwitchboardRoute(general, { project, sidequest: store.resolveCategoryRoute(general) });
  assert.equal(comparison.status, 'mismatch');
  assert.equal(comparison.authoritative, 'sidequest');
  assert.deepEqual(comparison.sidequest, { model: 'sonnet', effort: 'high' });
  assert.equal(comparison.switchboard.route.model, 'opus');
  assert.match(comparison.diagnostics[0], /Sidequest remains authoritative/);
});

test('missing Switchboard remains diagnostic and never blocks routing', () => {
  const previous = process.env.SIDEQUEST_DISCOVERY_DIRS;
  process.env.SIDEQUEST_DISCOVERY_DIRS = path.join(sandbox, 'missing-discovery');
  discovery.clearSwitchboardCache();
  try {
    const ticket = store.applyDerivedRouting({ category: 'general' }, { project });
    assert.equal(ticket.model, 'sonnet');
    const comparison = store.compareSwitchboardRoute(general, { project, sidequest: store.resolveCategoryRoute(general) });
    assert.equal(comparison.status, 'missing');
    assert.match(comparison.diagnostics.join(' '), /breadcrumb was not found/);
  } finally {
    process.env.SIDEQUEST_DISCOVERY_DIRS = previous;
    discovery.clearSwitchboardCache();
  }
});

test('global export enforces dry-run before apply and preserves unrelated Switchboard config', () => {
  fs.mkdirSync(path.dirname(userConfig), { recursive: true });
  fs.writeFileSync(userConfig, JSON.stringify({
    schemaVersion: 1,
    allowedModels: ['sonnet'],
    categories: { retained: { id: 'retained', name: 'Retained' } },
  }));
  store.setCategory({
    id: 'custom',
    name: 'Custom',
    description: 'Custom work.',
    contract: 'Run custom work.',
    route: { model: 'opus', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  store.setRoutingFallback({ model: 'sonnet', effort: 'high' });

  const before = fs.readFileSync(userConfig, 'utf8');
  const preview = store.exportSwitchboardRouting({ scope: 'global' });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(fs.readFileSync(userConfig, 'utf8'), before);
  assert.throws(() => store.exportSwitchboardRouting({ scope: 'global', apply: true }), /matching previewHash/);

  const applied = store.exportSwitchboardRouting({ scope: 'global', apply: true, previewHash: preview.previewHash });
  assert.equal(applied.applied, true);
  const written = JSON.parse(fs.readFileSync(userConfig, 'utf8'));
  assert.deepEqual(written.allowedModels, ['sonnet']);
  assert.equal(written.categories.retained.name, 'Retained');
  assert.equal(written.categories.custom.contract, 'Run custom work.');
  assert.deepEqual(written.globalFallback, { model: 'sonnet', effort: 'high' });
});

test('explicit project export preserves Sidequest rollback rows', () => {
  store.setProjectCategory(project, 'custom', 'OVERRIDE', { route: { model: 'sonnet', effort: 'xhigh' } });
  const rowsBefore = JSON.parse(JSON.stringify(store.getProjectCategories(project).rows));
  assert.throws(() => store.exportSwitchboardRouting({ scope: 'project' }), /explicit registered Sidequest board/);

  const preview = store.exportSwitchboardRouting({ scope: 'project', project });
  assert.equal(preview.target, projectConfig);
  assert.equal(fs.existsSync(projectConfig), false);
  const applied = store.exportSwitchboardRouting({ scope: 'project', project, apply: true, previewHash: preview.previewHash });
  assert.equal(applied.applied, true);
  const written = JSON.parse(fs.readFileSync(projectConfig, 'utf8'));
  assert.deepEqual(written.categories.custom, { kind: 'OVERRIDE', data: { route: { model: 'sonnet', effort: 'xhigh' } } });
  assert.deepEqual(store.getProjectCategories(project).rows, rowsBefore);
});

test('MCP exposes comparison diagnostics and guarded export', () => {
  process.env.SQ_FAKE_SWITCHBOARD_MODEL = 'opus';
  discovery.clearSwitchboardCache();
  const names = mcp.toolDescriptors().map((tool) => tool.name);
  assert.ok(names.includes('switchboard_status'));
  assert.ok(names.includes('switchboard_export'));

  const statusResponse = mcp.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'switchboard_status', arguments: { project: projectRoot } },
  });
  const status = JSON.parse(statusResponse.result.content[0].text);
  assert.equal(status.authoritative, 'sidequest');
  assert.ok(status.mismatches.includes('general'));

  const exportResponse = mcp.handleRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'switchboard_export', arguments: { scope: 'global' } },
  });
  const preview = JSON.parse(exportResponse.result.content[0].text);
  assert.equal(preview.dryRun, true);

  const refused = mcp.handleRequest({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'switchboard_export', arguments: { scope: 'project' } },
  });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /explicit board/);
});

test('dashboard host serves status, panel, and contract-v1 proxy without cutting over', { concurrency: false }, async (t) => {
  process.env.SQ_FAKE_SWITCHBOARD_MODEL = 'sonnet';
  discovery.clearSwitchboardCache();
  const started = await server.start(46000 + Math.floor(Math.random() * 1000));
  t.after(() => started.server.close());

  const statusResponse = await fetch(`${started.url}/api/switchboard/status?project=${encodeURIComponent(project)}`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.authoritative, 'sidequest');
  assert.equal(status.panel.available, true);

  const panelResponse = await fetch(`${started.url}/api/switchboard/panel.js`);
  assert.equal(panelResponse.status, 200);
  assert.match(await panelResponse.text(), /createPanel/);
  const panelHostResponse = await fetch(`${started.url}/api/switchboard/panel?scope=project&projectPath=${encodeURIComponent(projectRoot)}`);
  assert.equal(panelHostResponse.status, 200);
  assert.match(await panelHostResponse.text(), /sidequest-switchboard-mutated/);

  const settingsResponse = await fetch(`${started.url}/api/switchboard/host/settings?projectPath=${encodeURIComponent(projectRoot)}`);
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  assert.equal(settings.effective.categories[0].id, 'general');
  assert.equal(settings.contract.contractVersion, 1);

  const resolveResponse = await fetch(`${started.url}/api/switchboard/host/resolve?category=general&projectPath=${encodeURIComponent(projectRoot)}`);
  assert.equal(resolveResponse.status, 200);
  assert.equal((await resolveResponse.json()).route.model, 'sonnet');

  const saveResponse = await fetch(`${started.url}/api/switchboard/host/categories/general/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'project', projectPath: projectRoot, name: 'General', description: 'General work.', contract: 'Work the task.', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true }),
  });
  assert.equal(saveResponse.status, 200);
});

test('dashboard exposes migration diagnostics and mounts the panel only after host status succeeds', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /id="switchboardAdoption" hidden/);
  assert.match(html, /Sidequest still decides every route in this release/);
  assert.match(html, /data-switchboard-preview="global"/);
  assert.match(html, /data-switchboard-apply="project" disabled/);
  assert.match(html, /\/api\/switchboard\/status/);
  assert.match(html, /panelAvailable = status\.panel && status\.panel\.available/);
  assert.match(html, /Comparison mismatch:/);
});

test('export refuses an incompatible existing Switchboard schema without changing it', () => {
  fs.writeFileSync(projectConfig, JSON.stringify({ schemaVersion: 2, categories: {} }));
  const before = fs.readFileSync(projectConfig, 'utf8');
  assert.throws(() => store.exportSwitchboardRouting({ scope: 'project', project }), /supports contract v1 only/);
  assert.equal(fs.readFileSync(projectConfig, 'utf8'), before);
});
