import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  getRow,
  putRow,
  txn,
  type GlobalRow,
  type ProjectRow,
  type StoryRow,
  type TicketRow,
} from './db.js';

const GLOBAL_FILES = [
  ['model-prefs.json', 'model-prefs'],
  ['notifications.json', 'notifications'],
  ['notify-prefs.json', 'notify-prefs'],
  ['workers.json', 'workers'],
] as const;

interface MigrationRows {
  projects: ProjectRow[];
  tickets: TicketRow[];
  stories: StoryRow[];
  globals: GlobalRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function readRecord(file: string): Record<string, unknown> {
  const value = readJson(file);
  if (!isRecord(value)) throw new TypeError(`Expected a JSON object in ${file}.`);
  return value;
}

function jsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name) === '.json')
    .map((entry) => path.join(dir, entry.name));
}

function collectProject(rows: MigrationRows, projectsDir: string, slug: string): void {
  const dir = path.join(projectsDir, slug);
  const metaFile = path.join(dir, 'meta.json');
  if (fs.existsSync(metaFile)) {
    rows.projects.push({ slug, data: readJson(metaFile) });
  }

  for (const file of jsonFiles(path.join(dir, 'tickets'))) {
    const ticket = readRecord(file);
    const claim = isRecord(ticket.claim) ? ticket.claim : null;
    rows.tickets.push({
      id: ticket.id as string,
      project: slug,
      ref: ticket.ref ? ticket.ref as string : null,
      status: ticket.status ? ticket.status as string : null,
      archived: ticket.archived ? 1 : 0,
      ord: Number(ticket.order) || 0,
      claim_by: claim?.by ? claim.by as string : null,
      data: ticket,
    });
  }

  for (const file of jsonFiles(path.join(dir, 'stories'))) {
    const story = readRecord(file);
    rows.stories.push({ id: story.id as string, project: slug, data: story });
  }
}

function collectMigration(homeRoot: string): MigrationRows {
  const rows: MigrationRows = { projects: [], tickets: [], stories: [], globals: [] };
  const projectsDir = path.join(homeRoot, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) collectProject(rows, projectsDir, entry.name);
    }
  }

  for (const [filename, key] of GLOBAL_FILES) {
    const file = path.join(projectsDir, filename);
    if (fs.existsSync(file)) rows.globals.push({ key, data: readJson(file) });
  }

  const serverFile = path.join(homeRoot, 'server.json');
  if (fs.existsSync(serverFile)) rows.globals.push({ key: 'server-info', data: readJson(serverFile) });
  return rows;
}

export function migrateIfNeeded(database: DatabaseSync, homeRoot: string): void {
  if (getRow(database, 'meta', 'json_migrated') === '1') return;

  const rows = collectMigration(homeRoot);
  txn(database, () => {
    for (const row of rows.projects) putRow(database, 'projects', row);
    for (const row of rows.tickets) putRow(database, 'tickets', row);
    for (const row of rows.stories) putRow(database, 'stories', row);
    for (const row of rows.globals) putRow(database, 'globals', row);
    putRow(database, 'meta', { key: 'json_migrated', value: '1' });
  });
}
