import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from '../git-process.js';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalPath } from '../kernel/worktree.js';
import { reportFile } from '../sweep-state-path.js';

type StoredObject = Record<string, unknown>;
type Board = { slug: string; meta: StoredObject & { path: string } };
type MoveDependencies = {
  database(): DatabaseSync;
  transaction<Result>(operation: () => Result): Result;
  findProject(reference: string): { ok: boolean; slug?: string; meta?: Board['meta'] };
  slugify(directory: string): string;
  projectDir(slug: string): string;
  invalidateStoreCaches(): void;
};

function sourceBoard(dependencies: MoveDependencies, oldPath: string): Board {
  if (!path.isAbsolute(oldPath)) throw new Error('board move: source must be an absolute path');
  const found = dependencies.findProject(oldPath);
  if (!found.ok || !found.slug || !found.meta) throw new Error(`board move: no board at ${oldPath}`);
  return { slug: found.slug, meta: found.meta };
}

function destinationPath(dependencies: MoveDependencies, newPath: string): string {
  if (!path.isAbsolute(newPath)) throw new Error('board move: destination must be an absolute path');
  const destination = canonicalPath(newPath);
  if (dependencies.findProject(destination).ok) throw new Error(`board move: destination already has a board: ${destination}`);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: destination, encoding: 'utf8', timeout: 10000 }).trim();
  if (canonicalPath(root) !== destination) throw new Error(`board move: destination must be a git repository root: ${destination}`);
  return destination;
}

function blockedTickets(database: DatabaseSync, slug: string): string[] {
  return database.prepare('SELECT ref, data FROM tickets WHERE project = ?').all(slug).flatMap((row) => {
    const ticket: { claim?: { by?: string }; dispatch?: { terminalAt?: string } } = JSON.parse(String(row.data));
    const reasons = [];
    if (ticket.claim?.by) reasons.push(`${row.ref} claimed by ${ticket.claim.by}`);
    if (ticket.dispatch && !ticket.dispatch.terminalAt) reasons.push(`${row.ref} has a nonterminal dispatch`);
    return reasons;
  });
}

function reserveMoveFlights(paths: string[], operation: () => void): void {
  const flights = [...new Set(paths.map((directory) => reportFile(directory).replace(/\.json$/, '.flight')))];
  const acquired: string[] = [];
  try {
    for (const flight of flights) {
      fs.mkdirSync(path.dirname(flight), { recursive: true });
      fs.writeFileSync(flight, `${process.pid}:${crypto.randomUUID()}`, { flag: 'wx' });
      acquired.push(flight);
    }
    operation();
  } finally {
    for (const flight of acquired) fs.rmSync(flight);
  }
}

function relocatedPath(value: unknown, oldPath: string, newPath: string): unknown {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const relative = path.relative(canonicalPath(oldPath), canonicalPath(value));
  if (relative.split(path.sep).includes('..') || path.isAbsolute(relative)) return value;
  return path.join(newPath, relative);
}

function relocateCheckout(dispatch: StoredObject, oldPath: string, newPath: string): StoredObject {
  const relocated = { ...dispatch };
  for (const field of ['worktree', 'worktreeGitDirectory', 'worktreeCommonGitDirectory', 'sourceWorktree', 'observedWorktree', 'boundWorktree', 'gitDirectory', 'commonGitDirectory', 'boundGitDirectory', 'boundCommonGitDirectory', 'repository', 'target']) {
    if (field in relocated) relocated[field] = relocatedPath(relocated[field], oldPath, newPath);
  }
  relocateCheckoutChildren(relocated, oldPath, newPath);
  return relocated;
}

function relocateCheckoutChildren(record: StoredObject, oldPath: string, newPath: string): void {
  for (const field of ['continuation', 'lease', 'releaseObservedCheckout']) {
    const child = record[field];
    if (child && typeof child === 'object') record[field] = relocateCheckout(child as StoredObject, oldPath, newPath);
  }
  if (Array.isArray(record.ownedDependencyLinks)) record.ownedDependencyLinks = record.ownedDependencyLinks.map((link: StoredObject) => relocateCheckout(link, oldPath, newPath));
}

export function currentBoardPath(meta: { moves?: { from: string; to: string }[] }, recordedPath: string): string {
  return (meta.moves || []).reduce((current, move) => String(relocatedPath(current, move.from, move.to)), recordedPath);
}

function relocateDispatches(database: DatabaseSync, slug: string, oldPath: string, newPath: string): void {
  const update = database.prepare('UPDATE tickets SET data = ? WHERE id = ?');
  for (const row of database.prepare('SELECT id, data FROM tickets WHERE project = ?').all(slug)) {
    const ticket: StoredObject & { dispatch?: StoredObject } = JSON.parse(String(row.data));
    if (!ticket.dispatch) continue;
    ticket.dispatch = relocateCheckout(ticket.dispatch, oldPath, newPath);
    update.run(JSON.stringify(ticket), row.id!);
  }
}

function relocateWorkers(database: DatabaseSync, oldSlug: string, newSlug: string): void {
  const row = database.prepare("SELECT data FROM globals WHERE key = 'workers'").get();
  if (!row) return;
  const workers: { sessions: Record<string, { claims: { slug: string }[] }> } = JSON.parse(String(row.data));
  for (const session of Object.values(workers.sessions)) {
    for (const claim of session.claims) {
      if (claim.slug === oldSlug) claim.slug = newSlug;
    }
  }
  database.prepare("UPDATE globals SET data = ? WHERE key = 'workers'").run(JSON.stringify(workers));
}

function rekeyBoard(database: DatabaseSync, board: Board, destination: string, newSlug: string): void {
  const events = (board.meta.moves || []) as StoredObject[];
  const meta = { ...board.meta, path: destination, moves: [...events, { event: 'board.move', from: board.meta.path, to: destination, at: new Date().toISOString() }] };
  database.prepare('INSERT INTO projects (slug, data) VALUES (?, ?)').run(newSlug, JSON.stringify(meta));
  for (const table of ['tickets', 'stories', 'project_categories', 'project_routing_profiles']) {
    database.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).run(newSlug, board.slug);
  }
  relocateWorkers(database, board.slug, newSlug);
  database.prepare('DELETE FROM projects WHERE slug = ?').run(board.slug);
}

function relocateStoredFiles(source: string, target: string, operation: () => void): void {
  if (fs.existsSync(target)) throw new Error(`board move: destination storage already exists: ${target}`);
  fs.mkdirSync(target, { recursive: true });
  const moved: string[] = [];
  try {
    fs.mkdirSync(source, { recursive: true });
    const entries = fs.readdirSync(source);
    for (const entry of entries.filter((name) => name !== 'verification')) {
      fs.renameSync(path.join(source, entry), path.join(target, entry));
      moved.push(entry);
    }
    operation();
  } catch (error) {
    for (const entry of moved.reverse()) fs.renameSync(path.join(target, entry), path.join(source, entry));
    fs.rmdirSync(target);
    throw error;
  }
}

export function moveProject(dependencies: MoveDependencies, oldPath: string, newPath: string) {
  const board = sourceBoard(dependencies, oldPath);
  const destination = destinationPath(dependencies, newPath);
  const newSlug = dependencies.slugify(destination);
  const flights = [board.meta.path, destination].map((directory) => reportFile(directory).replace(/\.json$/, '.flight'));
  const blockers = [...blockedTickets(dependencies.database(), board.slug), ...flights.filter((file) => fs.existsSync(file)).map((file) => `sweep flight ${file}`)];
  if (blockers.length) throw new Error(`board move refused: ${blockers.join('; ')}`);
  reserveMoveFlights([board.meta.path, destination], () => {
    execFileSync('git', ['worktree', 'repair'], { cwd: destination, encoding: 'utf8', timeout: 10000 });
    relocateStoredFiles(dependencies.projectDir(board.slug), dependencies.projectDir(newSlug), () => dependencies.transaction(() => {
      const current = sourceBoard(dependencies, oldPath);
      const active = blockedTickets(dependencies.database(), current.slug);
      if (active.length) throw new Error(`board move refused: ${active.join('; ')}`);
      relocateDispatches(dependencies.database(), board.slug, board.meta.path, destination);
      rekeyBoard(dependencies.database(), current, destination, newSlug);
    }));
  });
  dependencies.invalidateStoreCaches();
  return { ok: true, from: board.slug, slug: newSlug, path: destination };
}
