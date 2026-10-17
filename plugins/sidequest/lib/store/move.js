"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var move_exports = {};
__export(move_exports, {
  currentBoardPath: () => currentBoardPath,
  moveProject: () => moveProject
});
module.exports = __toCommonJS(move_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_crypto = __toESM(require("node:crypto"));
var import_git_process = require("../git-process.js");
var import_worktree = require("../kernel/worktree.js");
var import_sweep_state_path = require("../sweep-state-path.js");
function sourceBoard(dependencies, oldPath) {
  if (!import_node_path.default.isAbsolute(oldPath)) throw new Error("board move: source must be an absolute path");
  const found = dependencies.findProject(oldPath);
  if (!found.ok || !found.slug || !found.meta) throw new Error(`board move: no board at ${oldPath}`);
  return { slug: found.slug, meta: found.meta };
}
function destinationPath(dependencies, newPath) {
  if (!import_node_path.default.isAbsolute(newPath)) throw new Error("board move: destination must be an absolute path");
  const destination = (0, import_worktree.canonicalPath)(newPath);
  if (dependencies.findProject(destination).ok) throw new Error(`board move: destination already has a board: ${destination}`);
  const root = (0, import_git_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], { cwd: destination, encoding: "utf8", timeout: 1e4 }).trim();
  if ((0, import_worktree.canonicalPath)(root) !== destination) throw new Error(`board move: destination must be a git repository root: ${destination}`);
  return destination;
}
function blockedTickets(database, slug) {
  return database.prepare("SELECT ref, data FROM tickets WHERE project = ?").all(slug).flatMap((row) => {
    const ticket = JSON.parse(String(row.data));
    const reasons = [];
    if (ticket.claim?.by) reasons.push(`${row.ref} claimed by ${ticket.claim.by}`);
    if (ticket.dispatch && !ticket.dispatch.terminalAt) reasons.push(`${row.ref} has a nonterminal dispatch`);
    return reasons;
  });
}
function reserveMoveFlights(paths, operation) {
  const flights = [...new Set(paths.map((directory) => (0, import_sweep_state_path.reportFile)(directory).replace(/\.json$/, ".flight")))];
  const acquired = [];
  try {
    for (const flight of flights) {
      import_node_fs.default.mkdirSync(import_node_path.default.dirname(flight), { recursive: true });
      import_node_fs.default.writeFileSync(flight, `${process.pid}:${import_node_crypto.default.randomUUID()}`, { flag: "wx" });
      acquired.push(flight);
    }
    operation();
  } finally {
    for (const flight of acquired) import_node_fs.default.rmSync(flight);
  }
}
function relocatedPath(value, oldPath, newPath) {
  if (typeof value !== "string" || !import_node_path.default.isAbsolute(value)) return value;
  const relative = import_node_path.default.relative((0, import_worktree.canonicalPath)(oldPath), (0, import_worktree.canonicalPath)(value));
  if (relative.split(import_node_path.default.sep).includes("..") || import_node_path.default.isAbsolute(relative)) return value;
  return import_node_path.default.join(newPath, relative);
}
function relocateCheckout(dispatch, oldPath, newPath) {
  const relocated = { ...dispatch };
  for (const field of ["worktree", "worktreeGitDirectory", "worktreeCommonGitDirectory", "sourceWorktree", "observedWorktree", "boundWorktree", "gitDirectory", "commonGitDirectory", "boundGitDirectory", "boundCommonGitDirectory", "repository", "target"]) {
    if (field in relocated) relocated[field] = relocatedPath(relocated[field], oldPath, newPath);
  }
  relocateCheckoutChildren(relocated, oldPath, newPath);
  return relocated;
}
function relocateCheckoutChildren(record, oldPath, newPath) {
  for (const field of ["continuation", "lease", "releaseObservedCheckout"]) {
    const child = record[field];
    if (child && typeof child === "object") record[field] = relocateCheckout(child, oldPath, newPath);
  }
  if (Array.isArray(record.ownedDependencyLinks)) record.ownedDependencyLinks = record.ownedDependencyLinks.map((link) => relocateCheckout(link, oldPath, newPath));
}
function currentBoardPath(meta, recordedPath) {
  return (meta.moves || []).reduce((current, move) => String(relocatedPath(current, move.from, move.to)), recordedPath);
}
function relocateDispatches(database, slug, oldPath, newPath) {
  const update = database.prepare("UPDATE tickets SET data = ? WHERE id = ?");
  for (const row of database.prepare("SELECT id, data FROM tickets WHERE project = ?").all(slug)) {
    const ticket = JSON.parse(String(row.data));
    if (!ticket.dispatch) continue;
    ticket.dispatch = relocateCheckout(ticket.dispatch, oldPath, newPath);
    update.run(JSON.stringify(ticket), row.id);
  }
}
function relocateWorkers(database, oldSlug, newSlug) {
  const row = database.prepare("SELECT data FROM globals WHERE key = 'workers'").get();
  if (!row) return;
  const workers = JSON.parse(String(row.data));
  for (const session of Object.values(workers.sessions)) {
    for (const claim of session.claims) {
      if (claim.slug === oldSlug) claim.slug = newSlug;
    }
  }
  database.prepare("UPDATE globals SET data = ? WHERE key = 'workers'").run(JSON.stringify(workers));
}
function rekeyBoard(database, board, destination, newSlug) {
  const events = board.meta.moves || [];
  const meta = { ...board.meta, path: destination, moves: [...events, { event: "board.move", from: board.meta.path, to: destination, at: (/* @__PURE__ */ new Date()).toISOString() }] };
  database.prepare("INSERT INTO projects (slug, data) VALUES (?, ?)").run(newSlug, JSON.stringify(meta));
  for (const table of ["tickets", "stories", "project_categories", "project_routing_profiles"]) {
    database.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).run(newSlug, board.slug);
  }
  relocateWorkers(database, board.slug, newSlug);
  database.prepare("DELETE FROM projects WHERE slug = ?").run(board.slug);
}
function relocateStoredFiles(source, target, operation) {
  if (import_node_fs.default.existsSync(target)) throw new Error(`board move: destination storage already exists: ${target}`);
  import_node_fs.default.mkdirSync(target, { recursive: true });
  const moved = [];
  try {
    import_node_fs.default.mkdirSync(source, { recursive: true });
    const entries = import_node_fs.default.readdirSync(source);
    for (const entry of entries.filter((name) => name !== "verification")) {
      import_node_fs.default.renameSync(import_node_path.default.join(source, entry), import_node_path.default.join(target, entry));
      moved.push(entry);
    }
    operation();
  } catch (error) {
    for (const entry of moved.reverse()) import_node_fs.default.renameSync(import_node_path.default.join(target, entry), import_node_path.default.join(source, entry));
    import_node_fs.default.rmdirSync(target);
    throw error;
  }
}
function moveProject(dependencies, oldPath, newPath) {
  const board = sourceBoard(dependencies, oldPath);
  const destination = destinationPath(dependencies, newPath);
  const newSlug = dependencies.slugify(destination);
  const flights = [board.meta.path, destination].map((directory) => (0, import_sweep_state_path.reportFile)(directory).replace(/\.json$/, ".flight"));
  const blockers = [...blockedTickets(dependencies.database(), board.slug), ...flights.filter((file) => import_node_fs.default.existsSync(file)).map((file) => `sweep flight ${file}`)];
  if (blockers.length) throw new Error(`board move refused: ${blockers.join("; ")}`);
  reserveMoveFlights([board.meta.path, destination], () => {
    (0, import_git_process.execFileSync)("git", ["worktree", "repair"], { cwd: destination, encoding: "utf8", timeout: 1e4 });
    relocateStoredFiles(dependencies.projectDir(board.slug), dependencies.projectDir(newSlug), () => dependencies.transaction(() => {
      const current = sourceBoard(dependencies, oldPath);
      const active = blockedTickets(dependencies.database(), current.slug);
      if (active.length) throw new Error(`board move refused: ${active.join("; ")}`);
      relocateDispatches(dependencies.database(), board.slug, board.meta.path, destination);
      rekeyBoard(dependencies.database(), current, destination, newSlug);
    }));
  });
  dependencies.invalidateStoreCaches();
  return { ok: true, from: board.slug, slug: newSlug, path: destination };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  currentBoardPath,
  moveProject
});
