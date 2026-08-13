#!/usr/bin/env node
"use strict";
const path = require("path");
const os = require("os");
const fs = require("node:fs/promises");
const store = require("../lib/store");
function fail(msg) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}
async function resolveProject(opts) {
  const arg = opts.project;
  if (arg) {
    const res = store.findProject(arg);
    if (res.ok) return { slug: res.slug, meta: res.meta };
    if (res.reason === "ambiguous") {
      const lines = res.matches.map((p) => `    "${p.name}" -> ${p.path}`).join("\n");
      fail(`--project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the path to disambiguate:
${lines}`);
    }
    if (path.isAbsolute(arg)) {
      let isDir = false;
      try {
        isDir = (await fs.stat(arg)).isDirectory();
      } catch (_) {
      }
      if (isDir) return store.ensureProject(store.nearestRepoRoot(path.resolve(arg)), opts.name);
    }
    const known = Array.from(new Set(res.known || []));
    fail(
      `--project "${arg}" does not match any registered board.` + (known.length ? ` Known projects: ${known.join(", ")}` : " No projects are registered yet.")
    );
  }
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = store.nearestRepoRoot(start);
  return store.ensureProject(dir, opts.name);
}
async function resolveWatchProject(opts) {
  if (!opts.project) fail("watch: --project must name the board root or registered board identity.");
  const resolved = await resolveProject(opts);
  if (!resolved?.slug) fail("watch: could not resolve the requested board identity.");
  return resolved;
}
function workerId(opts) {
  return String(
    opts.by || process.env.SIDEQUEST_AGENT || process.env.CLAUDE_SESSION_ID || "agent@" + os.hostname()
  );
}
function controlPlaneIdentity(opts) {
  const explicitBy = String(opts?.by || "").trim();
  if (explicitBy) return explicitBy;
  const executorBy = String(process.env.SIDEQUEST_AGENT || "").trim();
  if (executorBy) return executorBy;
  const session = sessionId(opts);
  return session ? `orchestrator-${session.slice(0, 12)}` : "control-plane";
}
function sessionId(opts) {
  const v = opts && opts.session || process.env.CLAUDE_CODE_SESSION_ID || // the id the runtime actually exports to tool subprocesses
  process.env.CLAUDE_SESSION_ID || // tolerated legacy/alt spelling
  process.env.SIDEQUEST_SESSION || "";
  return String(v).trim() || null;
}
async function bodyFromOpts(opts, command) {
  if (opts.body != null && opts["body-file"] != null) fail(`${command}: pass either -m/--body or --body-file, not both`);
  if (opts["body-file"] == null) return opts.body;
  try {
    return await fs.readFile(String(opts["body-file"]), "utf8");
  } catch (e) {
    fail(`${command}: couldn't read --body-file "${opts["body-file"]}": ${e && e.message || e}`);
  }
}
function addBodyComment(slug, idOrRef, by, body, source) {
  if (!body || !String(body).trim()) return null;
  return store.addComment(slug, idOrRef, { by, body, kind: "comment", source });
}
module.exports = { fail, resolveProject, resolveWatchProject, workerId, controlPlaneIdentity, sessionId, bodyFromOpts, addBodyComment };
