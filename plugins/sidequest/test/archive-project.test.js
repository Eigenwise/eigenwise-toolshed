'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-archive-project-test-'));
const store = require('../lib/store.js');

const ACTIVE_PATH = path.join(os.tmpdir(), 'sq-archive-project-test', 'active');
const ARCHIVED_PATH = path.join(os.tmpdir(), 'sq-archive-project-test', 'archived');
const active = store.ensureProject(ACTIVE_PATH, 'Active Board');
const archived = store.ensureProject(ARCHIVED_PATH, 'Archived Board');
store.createTicket(archived.slug, { title: 'todo' });
const doing = store.createTicket(archived.slug, { title: 'doing' });
store.updateTicket(archived.slug, doing.ref, { status: 'doing' });

function meta(slug) {
  return JSON.parse(fs.readFileSync(path.join(store.projectDir(slug), 'meta.json'), 'utf8'));
}

test('archive and unarchive persist a reversible metadata round trip', () => {
  const result = store.archiveProject(archived.slug);
  assert.deepStrictEqual(result.ok, true);
  assert.strictEqual(result.alreadyArchived, false);
  assert.ok(!Number.isNaN(Date.parse(result.archivedAt)));
  assert.strictEqual(meta(archived.slug).archivedAt, result.archivedAt);

  assert.deepStrictEqual(store.unarchiveProject(archived.slug), { ok: true, slug: archived.slug, wasArchived: true });
  assert.strictEqual(meta(archived.slug).archivedAt, undefined);
});

test('lists active and archived boards separately with counts and timestamp', () => {
  const result = store.archiveProject(archived.slug);
  assert.ok(store.listProjects().some((project) => project.slug === active.slug));
  assert.ok(!store.listProjects().some((project) => project.slug === archived.slug));

  const projects = store.listProjects({ archived: true });
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].slug, archived.slug);
  assert.strictEqual(projects[0].archivedAt, result.archivedAt);
  assert.deepStrictEqual(projects[0].counts, { todo: 1, doing: 1, done: 0 });
});

test('archived boards resolve by slug, name, and registered path', () => {
  for (const ref of [archived.slug, 'Archived Board', 'archived board', ARCHIVED_PATH]) {
    const found = store.findProject(ref);
    assert.strictEqual(found.ok, true);
    assert.strictEqual(found.slug, archived.slug);
  }
});

test('archive operations are idempotent and unknown boards are structured failures', () => {
  const stamp = meta(archived.slug).archivedAt;
  assert.deepStrictEqual(store.archiveProject(archived.slug), {
    ok: true, slug: archived.slug, archivedAt: stamp, alreadyArchived: true,
  });
  assert.deepStrictEqual(store.unarchiveProject(archived.slug), { ok: true, slug: archived.slug, wasArchived: true });
  assert.deepStrictEqual(store.unarchiveProject(archived.slug), { ok: true, slug: archived.slug, wasArchived: false });
  assert.deepStrictEqual(store.archiveProject('missing-project'), { ok: false, reason: 'not_found' });
  assert.deepStrictEqual(store.unarchiveProject('missing-project'), { ok: false, reason: 'not_found' });
});

test('legacy metadata remains active and ensureProject does not silently restore', () => {
  const activeMeta = meta(active.slug);
  delete activeMeta.archivedAt;
  fs.writeFileSync(path.join(store.projectDir(active.slug), 'meta.json'), JSON.stringify(activeMeta));
  assert.strictEqual(store.listProjects().find((project) => project.slug === active.slug).archivedAt, null);

  const result = store.archiveProject(archived.slug);
  store.ensureProject(ARCHIVED_PATH, 'Archived Board Renamed');
  assert.strictEqual(meta(archived.slug).archivedAt, result.archivedAt);
  assert.ok(!store.listProjects().some((project) => project.slug === archived.slug));
  store.unarchiveProject(archived.slug);
});
