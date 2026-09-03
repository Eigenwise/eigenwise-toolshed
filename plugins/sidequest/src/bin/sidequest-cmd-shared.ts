const path = require('path');
const os = require('os');
const fs = require('node:fs/promises');
const store = require('../lib/store');

function fail(msg: any) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}

async function resolveProject(opts: any) {
  const arg = opts.project;
  if (arg) {
    const res = store.findProject(arg);
    if (res.ok) return { slug: res.slug, meta: res.meta };
    if (res.reason === 'ambiguous') {
      const lines = res.matches.map((p: any) => `    "${p.name}" -> ${p.path}`).join('\n');
      fail(`--project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the path to disambiguate:\n${lines}`);
    }
    // An absolute path to a real directory: create (or reuse) its board. The dir
    // must exist so a typo'd path fails loudly here instead of minting junk;
    // idempotent keying means this can never produce a duplicate of an existing
    // board. Anything non-absolute (a name, a relative ref) falls through to the
    // registered-only error below.
    if (path.isAbsolute(arg)) {
      let isDir = false;
      try { isDir = (await fs.stat(arg)).isDirectory(); } catch (_: any) { /* missing/unreadable -> not a dir */ }
      if (isDir) return store.ensureProject(store.nearestRepoRoot(path.resolve(arg)), opts.name);
    }
    const known = Array.from(new Set(res.known || []));
    fail(
      `--project "${arg}" does not match any registered board.` +
      (known.length ? ` Known projects: ${known.join(', ')}` : ' No projects are registered yet.')
    );
  }
  // Anchor to the git repo the agent is working in, not the raw cwd. The Bash
  // env here has no CLAUDE_PROJECT_DIR, so this used to fall straight to
  // process.cwd() — meaning a `cd` into any subfolder (e.g. bin/docai_refactored)
  // minted a brand-new board on that subfolder path, splitting one repo into
  // several duplicate boards. nearestRepoRoot() collapses any subfolder back to
  // its repo root; a non-repo folder is returned unchanged, so plain notes dirs
  // behave as before. --project (above) still targets any board explicitly.
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = store.nearestRepoRoot(start);
  return store.ensureProject(dir, opts.name);
}


async function resolveWatchProject(opts: any) {
  if (!opts.project) fail('watch: --project must name the board root or registered board identity.');
  const resolved = await resolveProject(opts);
  if (!resolved?.slug) fail('watch: could not resolve the requested board identity.');
  return resolved;
}

function workerId(opts: any) {
  return String(
    opts.by || process.env.SIDEQUEST_AGENT || process.env.CLAUDE_SESSION_ID || 'agent@' + os.hostname()
  );
}

function controlPlaneIdentity(opts: any) {
  const explicitBy = String(opts?.by || '').trim();
  if (explicitBy) return explicitBy;
  const executorBy = String(process.env.SIDEQUEST_AGENT || '').trim();
  if (executorBy) return executorBy;
  const session = sessionId(opts);
  return session ? `orchestrator-${session.slice(0, 12)}` : 'control-plane';
}

function sessionId(opts: any) {
  const value =
    (opts && opts.session) ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.SIDEQUEST_SESSION ||
    '';
  return String(value).trim() || null;
}


async function bodyFromOpts(opts: any, command: any) {
  if (opts.body != null && opts['body-file'] != null) fail(`${command}: pass either -m/--body or --body-file, not both`);
  if (opts['body-file'] == null) return opts.body;
  try {
    return await fs.readFile(String(opts['body-file']), 'utf8');
  } catch (e: any) {
    fail(`${command}: couldn't read --body-file "${opts['body-file']}": ${(e && e.message) || e}`);
  }
}

function addBodyComment(slug: any, idOrRef: any, by: any, body: any, source: any) {
  if (!body || !String(body).trim()) return null;
  return store.addComment(slug, idOrRef, { by, body, kind: 'comment', source });
}


module.exports = { fail, resolveProject, resolveWatchProject, workerId, controlPlaneIdentity, sessionId, bodyFromOpts, addBodyComment };
