import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'sidequest.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-profiles-compat-home-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-profiles-compat-discovery-'));
const PROJECT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-profiles-compat-project-'));
fs.mkdirSync(path.join(PROJECT_PATH, 'docs'), { recursive: true });
process.env.SIDEQUEST_HOME = HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
process.env.CLAUDE_PROJECT_DIR = PROJECT_PATH;
process.env.SIDEQUEST_NO_HOT_RECYCLE = '1';

const store = require('../lib/store.js') as any;
const db = require('../lib/db.js') as any;
const mcp = require('../lib/mcp.js') as any;
const server = require('../lib/server.js') as any;
const project = store.ensureProject(PROJECT_PATH, 'Profiles compatibility board').slug;

function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [key, canonical((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function runCli(...args: string[]): any {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function callMcp(name: string, args: Record<string, unknown>): Promise<any> {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
  assert.ok(!response.result?.isError, response.result?.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

function requestJson(port: number, endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'GET' }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end();
  });
}

function categoryTaxonomy(categories: any[]): unknown[] {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    route: category.route,
    fallback: category.fallback,
    contract: category.contract,
    artifactRoots: category.artifactRoots,
    enabled: category.enabled,
  })).sort((a: any, b: any) => a.id.localeCompare(b.id));
}

test('v6 realistic category migration preserves effective taxonomy and refuses old-session writes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-profiles-v6-home-'));
  const dbPath = path.join(home, 'sidequest.db');
  const category = (id: string, name: string, route = { model: 'sonnet', effort: 'medium' }) => ({
    id, name, description: `${name} description`, route, fallback: null, contract: `${name} contract`, artifactRoots: [], enabled: true,
  });
  const categories = [
    category('general', 'General'),
    category('fixture.base', 'Base'),
    category('fixture.override', 'Override'),
    category('fixture.detach', 'Detach'),
    category('fixture.disable', 'Disable'),
  ];
  const add = category('fixture.add', 'Board add', { model: 'opus', effort: 'high' });
  const detached = { ...categories[3], name: 'Pinned detach', route: { model: 'fable', effort: 'high' } };
  const expected = [categories[0], categories[1], { ...categories[2], name: 'Board override' }, detached, add];
  const seed = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(dbPath)});
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE projects (slug TEXT PRIMARY KEY, data TEXT); CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE project_categories (project TEXT, id TEXT, kind TEXT, data TEXT, PRIMARY KEY (project, id)); INSERT INTO meta VALUES ('schema_version', '6');");
    database.prepare('INSERT INTO projects VALUES (?, ?)').run('fixture-board', JSON.stringify({ path: 'C:/fixture/board', name: 'Fixture board', seq: 0, storySeq: 0 }));
    for (const row of ${JSON.stringify(categories)}) database.prepare('INSERT INTO categories VALUES (?, ?)').run(row.id, JSON.stringify(row));
    database.prepare('INSERT INTO project_categories VALUES (?, ?, ?, ?)').run('fixture-board', 'fixture.add', 'ADD', ${JSON.stringify(JSON.stringify(add))});
    database.prepare('INSERT INTO project_categories VALUES (?, ?, ?, ?)').run('fixture-board', 'fixture.override', 'OVERRIDE', JSON.stringify({ name: 'Board override' }));
    database.prepare('INSERT INTO project_categories VALUES (?, ?, ?, ?)').run('fixture-board', 'fixture.detach', 'DETACH', ${JSON.stringify(JSON.stringify(detached))});
    database.prepare('INSERT INTO project_categories VALUES (?, ?, ?, ?)').run('fixture-board', 'fixture.disable', 'DISABLE', '{}');
    database.close();
  `;
  const seeded = spawnSync(process.execPath, ['-e', seed], { encoding: 'utf8', windowsHide: true });
  assert.equal(seeded.status, 0, seeded.stderr);

  const migrated = db.openDb(home);
  assert.equal(db.getRow(migrated, 'meta', 'schema_version'), 7);
  assert.deepEqual(migrated.prepare("SELECT profile_id FROM project_routing_profiles WHERE project = 'fixture-board'").get()?.profile_id, 'coding');
  assert.deepEqual(migrated.prepare('SELECT kind, base_profile_id FROM project_categories WHERE project = ? ORDER BY id').all('fixture-board').map((row: any) => [row.kind, row.base_profile_id]), [
    ['ADD', null], ['DETACH', 'coding'], ['DISABLE', 'coding'], ['OVERRIDE', 'coding'],
  ]);
  migrated.close();

  const inspect = String.raw`
    process.env.SIDEQUEST_HOME = ${JSON.stringify(home)};
    const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
    process.stdout.write(JSON.stringify(store.getCategories({ project: 'fixture-board' })));
  `;
  const effective = spawnSync(process.execPath, ['-e', inspect], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SIDEQUEST_HOME: home } });
  assert.equal(effective.status, 0, effective.stderr);
  assert.equal(digest(categoryTaxonomy(JSON.parse(effective.stdout))), digest(categoryTaxonomy(expected)));

  const legacy = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const { DatabaseSync } = require('node:sqlite');
    const filename = ${JSON.stringify(path.join(ROOT, 'lib', 'db.js'))};
    const source = fs.readFileSync(filename, 'utf8').replace('const CURRENT_SCHEMA_VERSION = 7;', 'const CURRENT_SCHEMA_VERSION = 6;');
    const legacy = new Module(filename); legacy.filename = filename; legacy.paths = Module._nodeModulePaths(path.dirname(filename)); legacy._compile(source, filename);
    const database = new DatabaseSync(${JSON.stringify(dbPath)});
    try { legacy.exports.putRow(database, 'globals', { key: 'legacy-write', data: true }); process.exitCode = 2; }
    catch (error) { process.stdout.write(String(error.message)); }
    finally { database.close(); }
  `;
  const refused = spawnSync(process.execPath, ['-e', legacy], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /schema 7 is newer than supported schema 6; refusing write/);
});

test('profile edits propagate, repoint previews report drift, and prepared dispatch attempts stamp policy changes', () => {
  const target = `w7-compat-${Date.now()}`;
  store.createRoutingProfile(target, { from: 'coding', name: 'W7 compatibility profile' });
  store.setRoutingProfileCategory(target, { id: 'w7.dispatch', name: 'W7 dispatch', description: 'Dispatch integration fixture', route: { model: 'sonnet', effort: 'medium' }, fallback: null, contract: 'Use the fixture.', artifactRoots: [], enabled: true });
  store.setProjectRoutingProfile(project, target, 'compatibility-test');

  const ticket = store.createTicket(project, { title: 'Prepared profile route', category: 'w7.dispatch', description: 'A sufficiently grounded integration fixture for dispatch policy refresh.' });
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId: 'w7-prepared' });
  assert.deepEqual(prepared.ticket.dispatch.route, { model: 'sonnet', effort: 'medium' });
  store.setRoutingProfileCategory(target, 'w7.dispatch', { route: { model: 'opus', effort: 'high' } });
  assert.deepEqual(store.getCategory('w7.dispatch', { project }).route, { model: 'opus', effort: 'high' });
  const superseded = store.getTicket(project, ticket.ref);
  assert.equal(superseded.dispatch.outcome, 'policy-changed');
  assert.equal(superseded.dispatchNonce, undefined);
  assert.equal(store.isSupersededDispatchToken(superseded, prepared.token), true);
  const refreshed = store.prepareDispatch(project, ticket.ref, { sessionId: 'w7-retry' });
  assert.deepEqual(refreshed.ticket.dispatch.route, { model: 'opus', effort: 'high' });

  const activeTicket = store.createTicket(project, { title: 'Launched profile route', category: 'w7.dispatch', description: 'A sufficiently grounded integration fixture for active dispatch policy refresh.' });
  const active = store.prepareDispatch(project, activeTicket.ref, { sessionId: 'w7-active' });
  assert.equal(store.recordDispatchLaunch(project, activeTicket.ref, { token: active.token, executor: active.ticket.dispatchExecutor, sessionId: 'w7-active', agentName: 'w7-agent' }).ok, true);
  store.setRoutingProfileCategory(target, 'w7.dispatch', { route: { model: 'fable', effort: 'high' } });
  assert.deepEqual(store.getCategory('w7.dispatch', { project }).route, { model: 'fable', effort: 'high' });
  const launched = store.getTicket(project, activeTicket.ref);
  assert.deepEqual(launched.dispatch.route, { model: 'opus', effort: 'high' });
  assert.equal(launched.dispatch.outcome, 'launched');
  assert.ok(launched.dispatch.policyChangedAt);

  const driftBoard = store.ensureProject(path.join(HOME, 'drift-board'), 'Drift board').slug;
  store.setProjectRoutingProfile(driftBoard, target, 'compatibility-test');
  store.setRoutingProfileCategory(target, 'w7.dispatch', { name: 'Changed route category' });
  const preview = store.repointRoutingProfiles(target, 'coding', { dryRun: true });
  const drift = preview.boards.find((board: any) => board.project === project);
  assert.ok(drift?.drift.hasDrift);
  assert.ok(drift.drift.changed.includes('w7.dispatch') || drift.drift.missing.includes('w7.dispatch') || drift.drift.added.includes('w7.dispatch'));
});

test('DETACH provenance remains visible and CLI, MCP, and REST agree on effective taxonomy', async (t: any) => {
  const pinned = store.ensureProject(path.join(HOME, 'pinned-board'), 'Pinned board').slug;
  const base = store.getCategory('coding.easy', { project: pinned });
  store.detachCategory(pinned, 'coding.easy');
  const row = store.getProjectCategories(pinned).rows.find((entry: any) => entry.id === 'coding.easy');
  assert.equal(row.kind, 'DETACH');
  assert.equal(row.baseProfileId, 'coding');

  const cli = runCli('category', 'list', '--project', pinned, '--json');
  const cliPinned = cli.categories.find((entry: any) => entry.id === 'coding.easy');
  assert.equal(cliPinned.origin, 'detached');
  assert.equal(cliPinned.baseProfileId, 'coding');
  assert.equal(cliPinned.name, base.name);

  const mcpPayload = await callMcp('category_list', { project: pinned, full: true });
  const mcpPinned = mcpPayload.categories.find((entry: any) => entry.id === 'coding.easy');
  assert.equal(mcpPinned.origin, 'detached');
  assert.equal(mcpPinned.baseProfileId, 'coding');

  const started = await server.start(45000 + Math.floor(Math.random() * 1000));
  t.after(() => started.server.close());
  const rest = await requestJson(started.port, `/api/categories?project=${encodeURIComponent(pinned)}`);
  assert.equal(rest.status, 200);
  const restPinned = rest.body.categories.find((entry: any) => entry.id === 'coding.easy');
  assert.equal(restPinned.origin, 'detached');
  assert.equal(restPinned.layer.kind, 'DETACH');
  assert.equal(restPinned.layer.base.id, 'coding.easy');

  const normalize = (entry: any) => ({ id: entry.id, name: entry.name, description: entry.description, route: entry.route, fallback: entry.fallback, contract: entry.contract, artifactRoots: entry.artifactRoots, enabled: entry.enabled });
  assert.deepEqual(categoryTaxonomy(cli.categories.map(normalize)), categoryTaxonomy(mcpPayload.categories.map(normalize)));
  assert.deepEqual(categoryTaxonomy(cli.categories.map(normalize)), categoryTaxonomy(rest.body.categories.filter((entry: any) => !entry.disabled).map(normalize)));

  const models = store.modelsPayload({ project: pinned, full: true });
  const modelPinned = models.categories.find((entry: any) => entry.id === 'coding.easy');
  assert.equal(modelPinned.origin, 'detached');
  assert.equal(modelPinned.baseProfileId, 'coding');
  const recipe = await callMcp('route_recipe', { project: pinned, category: 'coding.easy' });
  assert.deepEqual(recipe.categorySource, { kind: 'detached', baseProfileId: 'coding' });
  const config = store.boardConfig(pinned);
  assert.equal(config.overrides.items.find((entry: any) => entry.id === 'coding.easy').kind, 'DETACH');
  assert.equal(config.overrides.items.find((entry: any) => entry.id === 'coding.easy').baseProfileId, 'coding');
});

export {};
