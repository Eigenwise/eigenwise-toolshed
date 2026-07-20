'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_CATEGORIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'category-defaults.json'), 'utf8'));

function freshStore(options?: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-test-'));
  const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-discovery-'));
  if (options && options.catalog) {
    const dir = path.join(discovery, 'codex-gateway');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models: options.catalog }));
  }
  process.env.SIDEQUEST_HOME = home;
  process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
  delete require.cache[require.resolve('../lib/store.js')];
  const store = require('../lib/store.js');
  const slug = store.ensureProject(path.join(home, 'project'), 'Category test').slug;
  return { store, slug, home };
}

test('default categories match the current defaults contract', () => {
  const { store } = freshStore();
  const defaultsById = new Map<string, any>(DEFAULT_CATEGORIES.map((category?: any) => [category.id, category]));
  const categories = store.getCategories();

  assert.deepEqual(categories.map((category?: any) => category.id).sort(), [...defaultsById.keys()].sort());
  for (const expected of defaultsById.values()) {
    assert.ok(expected.route.model && store.VALID_EFFORTS.includes(expected.route.effort));
    if (expected.fallback) assert.ok(expected.fallback.model && store.VALID_EFFORTS.includes(expected.fallback.effort));
  }
  for (const category of categories) {
    assert.ok(category.route.model && store.VALID_EFFORTS.includes(category.route.effort));
    if (category.fallback) assert.ok(category.fallback.model && store.VALID_EFFORTS.includes(category.fallback.effort));
  }
  assert.throws(() => store.removeCategory('general'), /cannot be removed/);
  assert.throws(() => store.setCategory('general', { enabled: false }), /cannot be disabled/);
});

test('fallback chain resolves primary, category fallback, global fallback, and safety net', () => {
  const catalog = [{ slug: 'codex-gpt-test', id: 'gpt-test', label: 'GPT Test' }];
  const { store, slug, home } = freshStore({ catalog });
  store.setCategory({ id: 'route-test', name: 'Route test', route: { model: 'codex-gpt-test', effort: 'high' }, fallback: { model: 'opus', effort: 'medium' }, enabled: true });
  const created = store.createTicket(slug, { title: 'route', category: 'route-test' });
  assert.equal(store.getTicket(slug, created.ref).model, 'codex-gpt-test');

  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-empty-'));
  assert.equal(store.getTicket(slug, created.ref).model, 'opus');

  store.setCategory('route-test', { fallback: { model: 'codex-also-gone', effort: 'low' } });
  store.setRoutingFallback({ model: 'fable', effort: 'xhigh' });
  assert.equal(store.getTicket(slug, created.ref).model, 'fable');

  const script = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(path.join(home, 'sidequest.db'))});
    db.prepare("UPDATE globals SET data = ? WHERE key = 'routing-fallback'").run(JSON.stringify({ broken: true }));
    db.close();
  `;
  assert.equal(spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).status, 0);
  const safety = store.getTicket(slug, created.ref);
  assert.equal(safety.model, 'sonnet');
  assert.match(safety.warnings.join(' '), /hardwired sonnet\/high/);
});

test('routing-disabled board rejects dispatch but preserves direct claims and old metadata defaults', () => {
  const { store, slug } = freshStore();
  const ticket = store.createTicket(slug, { title: 'direct only', category: 'coding.easy' });
  assert.equal(store.listProjects().find((project?: any) => project.slug === slug).routing, 'enabled');
  assert.equal(store.setProjectRouting(slug, 'disabled').routing, 'disabled');
  assert.throws(() => store.prepareDispatch(slug, ticket.ref), /sidequest routing enabled/);
  const claim = store.claimTicket(slug, ticket.ref, 'inline-worker', { direct: true });
  assert.equal(claim.ok, true);
});

test('legacy project metadata defaults routing to enabled', () => {
  const { store, slug } = freshStore();
  const meta = store.readMeta(slug);
  delete meta.routing;
  const db = require('node:sqlite').DatabaseSync;
  const handle = new db(path.join(process.env.SIDEQUEST_HOME, 'sidequest.db'));
  handle.prepare('UPDATE projects SET data = ? WHERE slug = ?').run(JSON.stringify(meta), slug);
  handle.close();
  assert.equal(store.projectRoutingEnabled(slug), true);
  assert.equal(store.listProjects().find((project?: any) => project.slug === slug).routing, 'enabled');
});

test('legacy complexity maps to fixed categories at read time without persistence', () => {
  const { store, slug } = freshStore();
  for (const [complexity, category] of [[1, 'coding.easy'], [5, 'coding.normal'], [10, 'coding.hard']]) {
    const created = store.createTicket(slug, { title: String(complexity), complexity });
    const ticket = store.getTicket(slug, created.ref);
    assert.equal(ticket.category.id, category);
    assert.equal(ticket.categoryId, undefined);
    assert.match(ticket.warnings.join(' '), /Legacy complexity/);
  }
});

test('schema v2 migration materializes configured backends, fallbacks, and global fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-v2-'));
  const dbPath = path.join(home, 'sidequest.db');
  const seed = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE globals (key TEXT PRIMARY KEY, data TEXT); INSERT INTO meta VALUES ('schema_version', '2');");
    db.prepare('INSERT INTO categories VALUES (?, ?)').run('fixture', JSON.stringify({ id:'fixture', name:'Fixture', route:{model:'g' + 'rade-3',effort:'high'}, enabled:true }));
    db.prepare('INSERT INTO globals VALUES (?, ?)').run('model-prefs', JSON.stringify({ tierBackend:{['g' + 'rade-3']:'codex-gpt-test'} }));
    db.close();
  `;
  assert.equal(spawnSync(process.execPath, ['-e', seed], { encoding: 'utf8' }).status, 0);
  const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-discovery-'));
  fs.mkdirSync(path.join(discovery, 'codex-gateway'));
  fs.writeFileSync(path.join(discovery, 'codex-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models: [{ slug:'codex-gpt-test', id:'gpt-test' }] }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
  const db = require('../lib/db.js');
  const handle = db.openDb(home);
  assert.equal(db.getRow(handle, 'meta', 'schema_version'), 5);
  assert.deepEqual(db.getRow(handle, 'categories', 'fixture').route, { model: 'codex-gpt-test', effort: 'high' });
  assert.deepEqual(db.getRow(handle, 'categories', 'fixture').fallback, { model: 'opus', effort: 'high' });
  assert.deepEqual(db.getRow(handle, 'globals', 'routing-fallback'), { model: 'sonnet', effort: 'high' });
  assert.equal(db.getRow(handle, 'globals', 'model-prefs'), null);
  handle.close();
});

test('project category layers merge ADD, OVERRIDE, and DISABLE without leaking to another project', () => {
  const { store, slug, home } = freshStore();
  const other = store.ensureProject(path.join(home, 'other-project'), 'Other project').slug;
  const defaultNormalRoute = store.getCategory('coding.normal').route;

  store.setProjectCategory(slug, 'music-analysis', 'ADD', {
    name: 'Music analysis',
    description: 'Analyze a score.',
    contract: 'Read the score first.',
    route: { model: 'opus', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'medium' },
    enabled: true,
  });
  store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', {
    name: 'Local coding',
    route: { model: 'fable', effort: 'xhigh' },
  });
  store.setProjectCategory(slug, 'coding.easy', 'DISABLE');

  const local = store.getCategories({ project: slug });
  assert.equal(local.find((category?: any) => category.id === 'music-analysis').name, 'Music analysis');
  assert.equal(local.find((category?: any) => category.id === 'coding.normal').route.model, 'fable');
  assert.equal(local.some((category?: any) => category.id === 'coding.easy'), false);
  assert.equal(store.getCategories({ project: other }).some((category?: any) => category.id === 'music-analysis'), false);
  assert.equal(store.getCategories({ project: other }).find((category?: any) => category.id === 'coding.normal').route.model, defaultNormalRoute.model);

  const ticket = store.createTicket(slug, { title: 'Analyze song', category: 'music-analysis' });
  assert.equal(store.getTicket(slug, ticket.ref).category.id, 'music-analysis');
  assert.equal(store.listPayload(slug, {}).categories.some((category?: any) => category.id === 'music-analysis'), true);
  assert.equal(store.readyPayload(slug, {}).categories.some((category?: any) => category.id === 'music-analysis'), true);
  assert.equal(store.modelsPayload({ project: slug }).categories.some((category?: any) => category.id === 'music-analysis'), true);
});

test('project category layer guards reject invalid local changes', () => {
  const { store, slug } = freshStore();
  assert.throws(() => store.setProjectCategory(slug, 'general', 'DISABLE'), /cannot be disabled/);
  assert.throws(() => store.setProjectCategory(slug, 'coding.normal', 'ADD', {
    route: { model: 'opus', effort: 'high' },
  }), /collides with a global category/);
  assert.throws(() => store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', { enabled: false }), /cannot patch/);
});

test('deleting a global category auto-pins the customizations that depend on it', () => {
  const { store, slug, home } = freshStore();
  const other = store.ensureProject(path.join(home, 'other-project'), 'Other project').slug;
  const defaultNormalRoute = store.getCategory('coding.normal').route;
  store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', { name: 'Local coding' });

  store.removeCategory('coding.normal');

  // The board keeps a working, pinned copy instead of dropping into a broken
  // "global category missing" state — no dangling override to clean up.
  const pinned = store.getCategory('coding.normal', { project: slug });
  assert.equal(pinned.name, 'Local coding');
  assert.deepEqual(pinned.route, defaultNormalRoute);
  assert.deepEqual(store.getProjectCategories(slug).warnings, []);
  assert.equal(store.getCategory('coding.normal', { project: slug, withState: true }).linkState, 'detached');

  // A project that never customized the category simply loses it.
  assert.equal(store.getCategories({ project: other }).some((category?: any) => category.id === 'coding.normal'), false);
});

test('detached categories snapshot the merged view, survive deletion, and relink', () => {
  const { store, slug } = freshStore();
  store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', {
    name: 'Local coding',
    route: { model: 'fable', effort: 'xhigh' },
  });

  const detached = store.detachCategory(slug, 'coding.normal');
  assert.equal(detached.kind, 'DETACH');
  assert.equal(detached.data.name, 'Local coding');
  assert.deepEqual(detached.data.route, { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(store.getProjectCategories(slug).rows, [{
    id: detached.id,
    kind: detached.kind,
    data: detached.data,
  }]);
  // A forked category coexisting with its shared default is the normal state, not a warning.
  assert.deepEqual(store.getProjectCategories(slug).warnings, []);
  assert.throws(() => store.detachCategory(slug, 'coding.normal'), /already detached/);
  assert.equal(store.detachCategory(slug, 'general').kind, 'DETACH'); // general is forkable too
  store.removeProjectCategory(slug, 'general');
  assert.throws(() => store.detachCategory(slug, 'missing'), /does not resolve/);

  store.setCategory('coding.normal', { name: 'Global rename', route: { model: 'opus', effort: 'high' } });
  assert.equal(store.getCategory('coding.normal', { project: slug }).name, 'Local coding');
  assert.deepEqual(store.getCategory('coding.normal', { project: slug }).route, { model: 'fable', effort: 'xhigh' });

  store.removeCategory('coding.normal');
  assert.equal(store.getCategory('coding.normal', { project: slug }).name, 'Local coding');
  assert.deepEqual(store.getProjectCategories(slug).warnings, []);
  assert.equal(store.getCategoryRoutePairs().some(({ route }: any) => route.model === 'fable' && route.effort === 'xhigh'), true);

  assert.equal(store.removeProjectCategory(slug, 'coding.normal'), true);
  assert.equal(store.getCategory('coding.normal', { project: slug }), null);
});

test('category link state annotations are opt-in and identify changed override fields', () => {
  const { store, slug } = freshStore();
  store.setProjectCategory(slug, 'music-analysis', 'ADD', {
    name: 'Music analysis',
    description: 'Analyze a score.',
    contract: 'Read the score first.',
    route: { model: 'opus', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', {
    route: { model: 'fable', effort: 'xhigh' },
    name: 'Local coding',
  });
  store.detachCategory(slug, 'coding.hard');

  assert.equal(store.getCategory('coding.easy', { project: slug }).linkState, undefined);
  const categories = store.getCategories({ project: slug, withState: true });
  assert.deepEqual(
    Object.fromEntries(categories.filter(({ id }: any) => ['coding.easy', 'coding.normal', 'coding.hard', 'music-analysis'].includes(id)).map((category?: any) => [category.id, {
      linkState: category.linkState,
      changedFields: category.changedFields,
    }])),
    {
      'coding.easy': { linkState: 'linked', changedFields: undefined },
      'coding.hard': { linkState: 'detached', changedFields: undefined },
      'coding.normal': { linkState: 'overridden', changedFields: ['name', 'route'] },
      'music-analysis': { linkState: 'added', changedFields: undefined },
    },
  );
});

export {};
