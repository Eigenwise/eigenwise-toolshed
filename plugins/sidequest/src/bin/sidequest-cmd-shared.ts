const path = require('path');
const os = require('os');
const fs = require('node:fs/promises');
const store = require('../lib/store');

function fail(msg: any) {
  console.error(`sidequest: ${msg}`);
  process.exit(1);
}

function registeredBoard(registration: any) {
  if (!registration.ok) fail(registration.reason);
  return registration;
}

function unknownBoardFailure(arg: string, knownNames?: string[]) {
  const known = Array.from(new Set(knownNames || []));
  fail(
    `--project "${arg}" does not match any registered board.` +
    (known.length ? ` Known projects: ${known.join(', ')}` : ' No projects are registered yet.')
  );
}

function namedBoard(arg: string, name?: string) {
  const res = store.findProject(arg);
  if (res.ok) return { slug: res.slug, meta: res.meta };
  if (res.reason === 'ambiguous') {
    const lines = res.matches.map((p: any) => `    "${p.name}" -> ${p.path}`).join('\n');
    fail(`--project "${arg}" matches ${res.matches.length} boards named "${arg}" — pass the path to disambiguate:\n${lines}`);
  }
  // An absolute path registers (or reuses) its board, and may be a plain non-git
  // folder. Anything non-absolute (a name, a relative ref) must already be registered.
  if (path.isAbsolute(arg)) return registeredBoard(store.registerProject(store.explicitProjectRoot(arg), name));
  return unknownBoardFailure(arg, res.known);
}

async function resolveProject(opts: any) {
  if (opts.project) return namedBoard(opts.project, opts.name);
  // Anchor to the git repo the agent is working in, not the raw cwd: the Bash env
  // has no CLAUDE_PROJECT_DIR, and a `cd` into a subfolder used to mint a duplicate
  // board on that subfolder. A cwd outside any git repo gets no board implicitly.
  return registeredBoard(store.registerProject(store.sessionProjectRoot(), opts.name, { implicit: true }));
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
