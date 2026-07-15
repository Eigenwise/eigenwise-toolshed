'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const GLOBAL_FILES = [
  ['model-prefs.json', 'model-prefs'],
  ['notifications.json', 'notifications'],
  ['notify-prefs.json', 'notify-prefs'],
  ['workers.json', 'workers'],
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name) === '.json')
    .map((entry) => path.join(dir, entry.name));
}

function migrateProject(database, projectsDir, slug) {
  const dir = path.join(projectsDir, slug);
  const metaFile = path.join(dir, 'meta.json');
  if (fs.existsSync(metaFile)) {
    db.putRow(database, 'projects', { slug, data: readJson(metaFile) });
  }

  for (const file of jsonFiles(path.join(dir, 'tickets'))) {
    const ticket = readJson(file);
    db.putRow(database, 'tickets', {
      id: ticket.id,
      project: slug,
      ref: ticket.ref || null,
      status: ticket.status || null,
      archived: ticket.archived ? 1 : 0,
      ord: Number(ticket.order) || 0,
      claim_by: ticket.claim && ticket.claim.by ? ticket.claim.by : null,
      data: ticket,
    });
  }

  for (const file of jsonFiles(path.join(dir, 'stories'))) {
    const story = readJson(file);
    db.putRow(database, 'stories', { id: story.id, project: slug, data: story });
  }
}

function migrateIfNeeded(database, homeRoot) {
  if (db.getRow(database, 'meta', 'json_migrated') === '1') return;

  const projectsDir = path.join(homeRoot, 'projects');
  db.txn(database, () => {
    if (fs.existsSync(projectsDir)) {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) migrateProject(database, projectsDir, entry.name);
      }
    }

    for (const [filename, key] of GLOBAL_FILES) {
      const file = path.join(projectsDir, filename);
      if (fs.existsSync(file)) db.putRow(database, 'globals', { key, data: readJson(file) });
    }

    const serverFile = path.join(homeRoot, 'server.json');
    if (fs.existsSync(serverFile)) db.putRow(database, 'globals', { key: 'server-info', data: readJson(serverFile) });

    db.putRow(database, 'meta', { key: 'json_migrated', value: '1' });
  });
}

module.exports = { migrateIfNeeded };
