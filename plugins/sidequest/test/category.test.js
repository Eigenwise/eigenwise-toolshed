'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function freshStore(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-test-'));
  const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-discovery-'));
  if (options && options.catalog) {
    const dir = path.join(discovery, 'codex-gateway');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schema: 2, source: 'codex-gateway', models: options.catalog }));
  }
  process.env.SIDEQUEST_HOME = home;
  process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
  delete require.cache[require.resolve('../lib/store.js')];
  const store = require('../lib/store.js');
  const slug = store.ensureProject(path.join(home, 'project'), 'Category test').slug;
  return { store, slug, home };
}

test('default categories store concrete primary routes without fallbacks', () => {
  const { store } = freshStore();
  assert.equal(store.getCategories().length, 14);
  const normal = store.getCategory('coding.normal');
  assert.deepEqual(normal.route, { model: 'codex-gpt-5-6-terra', effort: 'high' });
  assert.equal(normal.fallback, null);
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
  fs.writeFileSync(path.join(discovery, 'codex-gateway', 'catalog.json'), JSON.stringify({ models: [{ slug:'codex-gpt-test', id:'gpt-test' }] }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
  const db = require('../lib/db.js');
  const handle = db.openDb(home);
  assert.equal(db.getRow(handle, 'meta', 'schema_version'), 4);
  assert.deepEqual(db.getRow(handle, 'categories', 'fixture').route, { model: 'codex-gpt-test', effort: 'high' });
  assert.deepEqual(db.getRow(handle, 'categories', 'fixture').fallback, { model: 'opus', effort: 'high' });
  assert.deepEqual(db.getRow(handle, 'globals', 'routing-fallback'), { model: 'sonnet', effort: 'high' });
  assert.equal(db.getRow(handle, 'globals', 'model-prefs'), null);
  handle.close();
});

test('project category layers merge ADD, OVERRIDE, and DISABLE without leaking to another project', () => {
  const { store, slug, home } = freshStore();
  const other = store.ensureProject(path.join(home, 'other-project'), 'Other project').slug;

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
  assert.equal(local.find((category) => category.id === 'music-analysis').name, 'Music analysis');
  assert.equal(local.find((category) => category.id === 'coding.normal').route.model, 'fable');
  assert.equal(local.some((category) => category.id === 'coding.easy'), false);
  assert.equal(store.getCategories({ project: other }).some((category) => category.id === 'music-analysis'), false);
  assert.equal(store.getCategories({ project: other }).find((category) => category.id === 'coding.normal').route.model, 'codex-gpt-5-6-terra');

  const ticket = store.createTicket(slug, { title: 'Analyze song', category: 'music-analysis' });
  assert.equal(store.getTicket(slug, ticket.ref).category.id, 'music-analysis');
  assert.equal(store.listPayload(slug, {}).categories.some((category) => category.id === 'music-analysis'), true);
  assert.equal(store.readyPayload(slug, {}).categories.some((category) => category.id === 'music-analysis'), true);
  assert.equal(store.modelsPayload({ project: slug }).categories.some((category) => category.id === 'music-analysis'), true);
});

test('project category layer guards reject invalid local changes and report dangling overrides', () => {
  const { store, slug } = freshStore();
  assert.throws(() => store.setProjectCategory(slug, 'general', 'DISABLE'), /cannot be disabled/);
  assert.throws(() => store.setProjectCategory(slug, 'coding.normal', 'ADD', {
    route: { model: 'opus', effort: 'high' },
  }), /collides with a global category/);
  assert.throws(() => store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', { enabled: false }), /cannot patch/);

  store.setProjectCategory(slug, 'coding.normal', 'OVERRIDE', { name: 'Local coding' });
  store.removeCategory('coding.normal');
  assert.equal(store.getCategories({ project: slug }).some((category) => category.id === 'coding.normal'), false);
  assert.deepEqual(store.getProjectCategories(slug).warnings, [
    { kind: 'dangling-override', id: 'coding.normal', project: slug },
  ]);
});

test('detached categories snapshot the merged view, shadow globals, survive deletion, and relink', () => {
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
  assert.deepEqual(store.getProjectCategories(slug).warnings, [
    { kind: 'shadows-global', id: 'coding.normal' },
  ]);
  assert.throws(() => store.detachCategory(slug, 'coding.normal'), /already detached/);
  assert.throws(() => store.detachCategory(slug, 'general'), /cannot be detached/);
  assert.throws(() => store.detachCategory(slug, 'missing'), /does not resolve/);

  store.setCategory('coding.normal', { name: 'Global rename', route: { model: 'opus', effort: 'high' } });
  assert.equal(store.getCategory('coding.normal', { project: slug }).name, 'Local coding');
  assert.deepEqual(store.getCategory('coding.normal', { project: slug }).route, { model: 'fable', effort: 'xhigh' });

  store.removeCategory('coding.normal');
  assert.equal(store.getCategory('coding.normal', { project: slug }).name, 'Local coding');
  assert.deepEqual(store.getProjectCategories(slug).warnings, []);
  assert.equal(store.getCategoryRoutePairs().some(({ route }) => route.model === 'fable' && route.effort === 'xhigh'), true);

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
    Object.fromEntries(categories.filter(({ id }) => ['coding.easy', 'coding.normal', 'coding.hard', 'music-analysis'].includes(id)).map((category) => [category.id, {
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
