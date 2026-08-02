"use strict";
const http = require("http");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const store = require("./store");
const DASHBOARD_DIST = path.join(__dirname, "..", "dashboard", "dist");
let PLUGIN_VERSION = null;
try {
  PLUGIN_VERSION = require("../.claude-plugin/plugin.json").version || null;
} catch (_) {
}
const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
const START_TIME = (/* @__PURE__ */ new Date()).toISOString();
const COMPACTION_SUGGESTIONS_ENABLED = !["0", "false", "no", "off"].includes(String(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS || "").trim().toLowerCase());
const CATEGORY_DRAFT_CLI = process.env.SIDEQUEST_CLAUDE_BIN || "claude";
const CATEGORY_DRAFT_TIMEOUT_MS = 60 * 1e3;
let categoryDraftTimeoutMs = CATEGORY_DRAFT_TIMEOUT_MS;
const CATEGORY_DRAFT_MAX_OUTPUT = 64 * 1024;
let categoryDraftAvailable = false;
let categoryDraftSpawn = spawn;
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
function staticCacheControl(pathname) {
  return pathname.startsWith("/assets/") && /-[a-zA-Z0-9_-]{8,}\.[^/]+$/.test(pathname) ? "public, max-age=31536000, immutable" : "no-store";
}
async function readStaticFile(file) {
  try {
    return await fsp.readFile(file);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}
async function serveStatic(pathname, res) {
  if (pathname === "/" || pathname === "/index.html") {
    const shell = await readStaticFile(path.join(DASHBOARD_DIST, "index.html"));
    if (!shell) {
      sendText(res, 500, "sidequest dashboard file is missing. Reinstall the plugin.", "text/plain; charset=utf-8");
      return true;
    }
    sendText(res, 200, shell, "text/html; charset=utf-8");
    return true;
  }
  const parts = pathname.split("/");
  if (!pathname.startsWith("/") || parts.includes("..") || pathname.includes("\0")) return false;
  const relative = parts.filter(Boolean).join(path.sep);
  if (!relative) return false;
  const file = path.resolve(DASHBOARD_DIST, relative);
  if (file !== DASHBOARD_DIST && !file.startsWith(`${DASHBOARD_DIST}${path.sep}`)) return false;
  const data = await readStaticFile(file);
  if (!data) return false;
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": staticCacheControl(pathname),
    "Content-Length": data.length
  });
  res.end(data);
  return true;
}
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > (limitBytes || 25 * 1024 * 1024)) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const parsed = JSON.parse(raw.toString("utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}
function storiesWithCounts(slug) {
  const counts = {};
  for (const t of store.listTickets(slug)) {
    if (t.archived || !t.storyId) continue;
    counts[t.storyId] = (counts[t.storyId] || 0) + 1;
  }
  const meta = store.readMeta(slug);
  return store.listStories(slug).map(
    (s) => Object.assign({}, s, { projectSlug: slug, projectName: meta ? meta.name : slug, ticketCount: counts[s.id] || 0 })
  );
}
function annotateReminders(tickets) {
  const map = store.pendingReminders();
  const now = Date.now();
  for (const t of tickets) {
    t.reminder = map.get(t.id) || null;
  }
  return tickets;
}
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query || {};
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      name: "sidequest",
      pid: process.pid,
      startedAt: START_TIME,
      version: PLUGIN_VERSION,
      compactionSuggestionsEnabled: COMPACTION_SUGGESTIONS_ENABLED
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/projects") {
    sendJson(res, 200, { projects: store.listProjects() });
    return;
  }
  if (req.method === "GET" && pathname === "/api/projects/archived") {
    sendJson(res, 200, { projects: store.listProjects({ archived: true }) });
    return;
  }
  const projectAction = /^\/api\/projects\/([^/]+)\/(archive|unarchive)$/.exec(pathname);
  if (req.method === "POST" && projectAction) {
    const result = projectAction[2] === "archive" ? store.archiveProject(projectAction[1]) : store.unarchiveProject(projectAction[1]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  const projectDelete = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && projectDelete) {
    const result = store.deleteProjectExact(projectDelete[1]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  const pr = /^\/api\/projects\/([^/]+)\/routing$/.exec(pathname);
  if ((req.method === "POST" || req.method === "PUT") && pr) {
    let body;
    try {
      body = await readJsonBody(req);
      if (!["enabled", "disabled"].includes(body.routing)) throw new Error();
    } catch (_) {
      sendJson(res, 400, { error: "routing must be enabled or disabled" });
      return;
    }
    const result = store.setProjectRouting(pr[1], body.routing);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  const pn = /^\/api\/projects\/([^/]+)\/notify$/.exec(pathname);
  if ((req.method === "POST" || req.method === "PUT") && pn) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    const result = store.setProjectNotify(pn[1], body.on);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  if (req.method === "GET" && pathname === "/api/stories") {
    const project = q.project ? String(q.project) : "all";
    if (project === "all" || project === "") {
      const out = [];
      for (const p of store.listProjects()) out.push(...storiesWithCounts(p.slug));
      sendJson(res, 200, { project: "all", stories: out });
    } else {
      if (!store.readMeta(project)) {
        sendJson(res, 404, { error: "unknown project" });
        return;
      }
      sendJson(res, 200, { project, stories: storiesWithCounts(project) });
    }
    return;
  }
  if (req.method === "POST" && pathname === "/api/stories") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    let slug = body.project && String(body.project);
    if ((!slug || slug === "all") && body.projectPath) {
      slug = store.ensureProject(body.projectPath, body.projectName).slug;
    }
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "a project is required to create a story" });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: "unknown project" });
      return;
    }
    const story = store.createStory(slug, { title: body.title, description: body.description, color: body.color });
    sendJson(res, 201, { story });
    return;
  }
  const sm = /^\/api\/stories\/([^/]+)$/.exec(pathname);
  if (sm) {
    const idOrRef = sm[1];
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: "bad JSON body" });
        return;
      }
      const updated = store.updateStory(slug, idOrRef, body);
      if (!updated) {
        sendJson(res, 404, { error: "story not found" });
        return;
      }
      sendJson(res, 200, { story: updated });
      return;
    }
    if (req.method === "DELETE") {
      const ok = store.deleteStory(slug, idOrRef);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
  }
  if (req.method === "GET" && pathname === "/api/tickets") {
    const project = q.project ? String(q.project) : "all";
    const archivedOnly = q.archived === "1" || q.archived === "true";
    if (project === "all" || project === "") {
      sendJson(res, 200, { project: "all", archived: archivedOnly, tickets: annotateReminders(store.listAllProjectTickets(archivedOnly)) });
    } else {
      const meta = store.readMeta(project);
      if (!meta) {
        sendJson(res, 404, { error: "unknown project" });
        return;
      }
      const tickets = store.listTickets(project).filter((t) => archivedOnly ? t.archived : !t.archived);
      sendJson(res, 200, { project, archived: archivedOnly, tickets: annotateReminders(tickets) });
    }
    return;
  }
  if (req.method === "POST" && pathname === "/api/tickets") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    let slug = body.project && String(body.project);
    if ((!slug || slug === "all") && body.projectPath) {
      slug = store.ensureProject(body.projectPath, body.projectName).slug;
    }
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "a project is required to create a ticket" });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: "unknown project" });
      return;
    }
    const category = body.category == null ? null : String(body.category).trim().toLowerCase();
    if (category && !store.getCategory(category)) {
      sendJson(res, 400, { error: "unknown category" });
      return;
    }
    if (!category && !body.unclassified && !store.coerceComplexity(body.complexity)) {
      sendJson(res, 400, { error: "choose a category or provide a complexity score" });
      return;
    }
    if (!category && !body.unclassified && (!body.complexityWhy || String(body.complexityWhy).trim().length < 20)) {
      sendJson(res, 400, { error: "complexityWhy is required with a complexity score (min 20 chars)" });
      return;
    }
    const ticket = store.createTicket(slug, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      storyId: body.storyId,
      category,
      complexity: body.complexity,
      complexityWhy: body.complexityWhy,
      files: body.files,
      executorAnchors: body.executorAnchors,
      executorVerify: body.executorVerify,
      assignee: body.assignee,
      imagesData: body.imagesData,
      source: "dashboard"
    });
    const created = store.getTicket(slug, ticket.id) || ticket;
    sendJson(res, 201, { ticket: created, warnings: store.ticketPlanningWarnings(created, (store.readMeta(slug) || {}).path) });
    return;
  }
  const m = /^\/api\/tickets\/([^/]+)$/.exec(pathname);
  if (m) {
    const idOrRef = m[1];
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: "bad JSON body" });
        return;
      }
      const updated = store.updateTicket(slug, idOrRef, Object.assign({}, body, { source: "dashboard" }));
      if (!updated) {
        sendJson(res, 404, { error: "ticket not found" });
        return;
      }
      updated.reminder = store.getPendingReminder(updated.id);
      sendJson(res, 200, { ticket: updated, warnings: store.ticketPlanningWarnings(updated, (store.readMeta(slug) || {}).path) });
      return;
    }
    if (req.method === "DELETE") {
      const ok = store.deleteTicket(slug, idOrRef);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
  }
  const cm = /^\/api\/tickets\/([^/]+)\/comment$/.exec(pathname);
  if (req.method === "POST" && cm) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    const result = store.addComment(slug, cm[1], { by: body.by || "you", body: body.body, kind: body.kind, source: "dashboard" });
    if (!result.ok) {
      const payload = { error: result.reason };
      if (result.reason === "too_long") {
        payload.max = result.max;
        payload.length = result.length;
      }
      sendJson(res, result.reason === "not_found" ? 404 : 400, payload);
      return;
    }
    sendJson(res, 201, result);
    return;
  }
  const rm = /^\/api\/tickets\/([^/]+)\/reminder$/.exec(pathname);
  if (rm) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: "bad JSON body" });
        return;
      }
      const result = store.setReminder(slug, rm[1], body.fireAt);
      if (!result.ok) {
        sendJson(res, result.reason === "not_found" ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 201, result);
      return;
    }
    if (req.method === "DELETE") {
      const result = store.cancelReminder(slug, rm[1]);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }
  }
  const lk = /^\/api\/tickets\/([^/]+)\/link$/.exec(pathname);
  if (req.method === "POST" && lk) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    const result = store.linkTickets(slug, lk[1], body.verb, body.to);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  const ulk = /^\/api\/tickets\/([^/]+)\/link\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && ulk) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    const result = store.unlinkTickets(slug, ulk[1], ulk[2]);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  const ar = /^\/api\/tickets\/([^/]+)\/(archive|unarchive)$/.exec(pathname);
  if (req.method === "POST" && ar) {
    const slug = q.project ? String(q.project) : null;
    if (!slug || slug === "all") {
      sendJson(res, 400, { error: "project query param is required" });
      return;
    }
    const fn = ar[2] === "archive" ? store.archiveTicket : store.unarchiveTicket;
    const result = fn(slug, ar[1], { source: "dashboard" });
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  if (req.method === "POST" && pathname === "/api/archive-done") {
    const slug = q.project ? String(q.project) : "all";
    if (slug === "all") {
      const all = [];
      for (const p of store.listProjects()) all.push(...store.archiveAllDone(p.slug, { source: "dashboard" }).archived);
      sendJson(res, 200, { ok: true, archived: all });
      return;
    }
    if (!store.readMeta(slug)) {
      sendJson(res, 404, { error: "unknown project" });
      return;
    }
    sendJson(res, 200, store.archiveAllDone(slug, { source: "dashboard" }));
    return;
  }
  if (req.method === "GET" && pathname === "/api/notifications") {
    const opts = {};
    if (q.project && q.project !== "all") opts.projectSlug = String(q.project);
    if (q.kind) opts.kind = String(q.kind);
    if (q.unread === "1" || q.unread === "true") opts.unreadOnly = true;
    if (q.includePending === "1" || q.includePending === "true") opts.includePending = true;
    if (q.limit) opts.limit = Number(q.limit);
    const notifications = store.listNotifications(opts);
    const unreadList = store.listNotifications(Object.assign({}, opts, { unreadOnly: true, kind: void 0, limit: void 0 }));
    const unread = unreadList.length;
    const unreadNeeds = unreadList.filter((n) => n.kind === "reminder").length;
    sendJson(res, 200, { notifications, unread, unreadNeeds });
    return;
  }
  if (req.method === "POST" && pathname === "/api/notifications/read") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    if (body.all) {
      const count = store.markAllRead();
      sendJson(res, 200, { ok: true, count });
      return;
    }
    if (!body.id) {
      sendJson(res, 400, { error: "id or all is required" });
      return;
    }
    const updated = store.markRead(String(body.id));
    if (!updated) {
      sendJson(res, 404, { error: "notification not found" });
      return;
    }
    sendJson(res, 200, { ok: true, notification: updated });
    return;
  }
  const nm = /^\/api\/notifications\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && nm) {
    const ok = store.dismiss(nm[1]);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }
  if (req.method === "GET" && pathname === "/api/notify-prefs") {
    sendJson(res, 200, { prefs: store.getNotifyPrefs() });
    return;
  }
  if ((req.method === "PUT" || req.method === "POST") && pathname === "/api/notify-prefs") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "bad JSON body" });
      return;
    }
    sendJson(res, 200, { prefs: store.setNotifyPrefs(body) });
    return;
  }
  const am = /^\/api\/asset\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (req.method === "GET" && am) {
    const [, slug, id, filename] = am;
    const file = store.assetPath(slug, id, filename);
    try {
      const data = await fsp.readFile(file);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": data.length });
      res.end(data);
    } catch (_) {
      sendText(res, 404, "not found");
    }
    return;
  }
  if (req.method === "GET" && await serveStatic(pathname, res)) return;
  sendJson(res, 404, { error: "not found" });
}
const REMINDER_TICK_MS = 15 * 1e3;
function startReminderScheduler() {
  const tick = () => {
    try {
      store.fireDueReminders();
    } catch (_) {
    }
  };
  tick();
  const timer = setInterval(tick, REMINDER_TICK_MS);
  timer.unref();
  return timer;
}
const VERSION_WATCH_MS = Number(process.env.SIDEQUEST_VERSION_WATCH_MS) || 20 * 1e3;
const CLEAN_SEMVER_RE = /^\d+\.\d+\.\d+$/;
let recycling = false;
function pickNewerInstall(entries, selfVersion) {
  if (!Array.isArray(entries) || typeof selfVersion !== "string" || !CLEAN_SEMVER_RE.test(selfVersion)) return null;
  const self = selfVersion.split(".").map(Number);
  let best = null;
  for (const entry of entries) {
    if (!entry || entry.hasBin !== true) continue;
    const version = entry.version;
    if (typeof version !== "string" || !CLEAN_SEMVER_RE.test(version)) continue;
    const parts = version.split(".").map(Number);
    let cmp = 0;
    for (let i = 0; i < 3 && cmp === 0; i++) cmp = parts[i] - self[i];
    if (cmp <= 0) continue;
    if (!best) {
      best = { name: entry.name, parts };
      continue;
    }
    let cmpBest = 0;
    for (let i = 0; i < 3 && cmpBest === 0; i++) cmpBest = parts[i] - best.parts[i];
    if (cmpBest > 0) best = { name: entry.name, parts };
  }
  return best ? best.name : null;
}
async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (_) {
    return false;
  }
}
async function runnableInstall(root) {
  if (typeof root !== "string") return false;
  const [hasBin, hasManifest] = await Promise.all([
    pathExists(path.join(root, "bin", "sidequest.js")),
    pathExists(path.join(root, ".claude-plugin", "plugin.json"))
  ]);
  return hasBin && hasManifest;
}
async function findNewerInstall(options) {
  try {
    const opts = options || {};
    const selfRoot = opts.selfRoot || path.resolve(__dirname, "..");
    const selfVersion = opts.selfVersion || path.basename(selfRoot);
    if (!CLEAN_SEMVER_RE.test(selfVersion)) return null;
    if (process.env.SIDEQUEST_NO_HOT_RECYCLE && !opts.ignoreOptOut) return null;
    const claudeHome = opts.claudeHome || process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), ".claude");
    const registryPath = opts.registryPath || path.join(claudeHome, "plugins", "installed_plugins.json");
    let registry;
    try {
      registry = JSON.parse(await fsp.readFile(registryPath, "utf8"));
    } catch (_) {
      registry = null;
    }
    const installed = registry && registry.plugins && registry.plugins["sidequest@eigenwise-toolshed"];
    if (Array.isArray(installed)) {
      const entries2 = await Promise.all(installed.map(async (install) => {
        const root = install && install.installPath;
        return {
          name: root,
          version: install && install.version,
          hasBin: await runnableInstall(root)
        };
      }));
      const target2 = pickNewerInstall(entries2, selfVersion);
      if (target2) return path.join(target2, "bin", "sidequest.js");
    }
    const parent = path.dirname(selfRoot);
    const names = await fsp.readdir(parent);
    const entries = await Promise.all(names.map(async (name) => {
      const dir = path.join(parent, name);
      return { name, version: name, hasBin: await runnableInstall(dir) };
    }));
    const target = pickNewerInstall(entries, selfVersion);
    return target ? path.join(parent, target, "bin", "sidequest.js") : null;
  } catch (_) {
    return null;
  }
}
function runNodeCheck(file) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    try {
      const child = spawn(process.execPath, ["--check", file], { stdio: "ignore", windowsHide: true });
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    } catch (_) {
      finish(false);
    }
  });
}
async function canRunInstall(targetBin) {
  try {
    const targetRoot = path.resolve(targetBin, "..", "..");
    const checks = await Promise.all([
      runNodeCheck(targetBin),
      runNodeCheck(path.join(targetRoot, "lib", "server.js"))
    ]);
    return checks.every(Boolean);
  } catch (_) {
    return false;
  }
}
function startVersionWatch(server, ownPort, reminderTimer) {
  let checkingForUpdate = false;
  const watchTimer = setInterval(async () => {
    try {
      if (recycling || checkingForUpdate) return;
      checkingForUpdate = true;
      const targetBin = await findNewerInstall();
      if (!targetBin) return;
      if (!await canRunInstall(targetBin)) {
        try {
          process.stderr.write(`sidequest: newer install failed preflight (${targetBin}) — keeping the current dashboard
`);
        } catch (_) {
        }
        return;
      }
      recycling = true;
      try {
        process.stderr.write(`sidequest: newer install found (${targetBin}) — handing off port ${ownPort}
`);
      } catch (_) {
      }
      let child;
      try {
        child = spawn(process.execPath, [targetBin, "serve", "--port", String(ownPort), "--handoff-pid", String(process.pid)], {
          cwd: os.homedir(),
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.once("error", () => {
          recycling = false;
        });
        child.unref();
      } catch (_) {
        recycling = false;
        return;
      }
      clearInterval(reminderTimer);
      clearInterval(watchTimer);
      server.close(() => {
        try {
          const cur = store.readServerInfo();
          if (cur && cur.pid === process.pid) store.clearServerInfo();
        } catch (_) {
        }
        process.exit(0);
      });
    } catch (_) {
    } finally {
      checkingForUpdate = false;
    }
  }, VERSION_WATCH_MS);
  watchTimer.unref();
  return watchTimer;
}
function listenOn(server, port, host, triesLeft) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (err && (err.code === "EADDRINUSE" || err.code === "EACCES") && triesLeft > 0) {
        resolve(listenOn(server, port + 1, host, triesLeft - 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
async function start(requestedPort) {
  const host = "127.0.0.1";
  const startPort = Number(requestedPort) || Number(process.env.SIDEQUEST_PORT) || 41730;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: String(err && err.message || err) });
      } catch (_) {
      }
    });
  });
  const port = await listenOn(server, startPort, host, 700);
  const info = { port, pid: process.pid, url: `http://${host}:${port}`, startedAt: START_TIME, version: PLUGIN_VERSION };
  store.writeServerInfo(info);
  const reminderTimer = startReminderScheduler();
  const watchTimer = startVersionWatch(server, port, reminderTimer);
  const cleanup = () => {
    clearInterval(reminderTimer);
    clearInterval(watchTimer);
    const cur = store.readServerInfo();
    if (cur && cur.pid === process.pid) store.clearServerInfo();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  return { server, port, url: info.url };
}
module.exports = { start, listenOn, pickNewerInstall, findNewerInstall };
