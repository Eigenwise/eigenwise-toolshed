'use strict';
/**
 * sidequest - runtime exec agent sync for live category routes (SQ-158)
 *
 * syncExecAgents() reads the live routing taxonomy, including global categories
 * and project-scoped layers, then generates the concrete executor definitions
 * needed by the current routes and fallbacks. Each file is marked as owned by
 * Sidequest. Reconciliation updates wanted files and prunes stale marked files,
 * while never touching an unmarked user-authored agent.
 *
 * Claude Code watches user agent definitions written mid-session, including
 * Codex frontmatter pins. Registration takes minutes and the harness announces
 * when a definition is ready. Spawning before that point silently runs a generic
 * agent, so per-ticket executors carry a dispatch nonce that turns that mistake
 * into a claim refusal. Deleting an agent definition hot-applies too.
 *
 * A registered agent file with a `model: <full-id>` frontmatter pin genuinely
 * runs through codex-gateway when spawned with the Agent `model` parameter
 * omitted. Passing an Agent `model` value overrides the pin, so Codex routes
 * advertise `model: null`. Every concrete Codex category route therefore gets
 * sidequest-exec-<source>-<slug>-<effort>.md in the user's live agents directory.
 *
 * syncExecAgents() renders through scripts/_exec-template.md via
 * renderExecAgent() below, so the ticket-execution protocol body stays in one
 * place for every generated file.
 *
 * Lifecycle safety: every file this module writes starts with MARKER on its
 * own line. A file WITHOUT the marker — whether or not its name collides with
 * one we'd generate — is NEVER written, overwritten, or deleted; it isn't ours.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'scripts', '_exec-template.md');

// Marks a file as ours. Must stay unique enough that no human-authored agent
// file would plausibly contain it verbatim.
const MARKER = '<!-- generated-by: sidequest-agentsync -->';
const TEMP_MARKER = '<!-- generated-by: sidequest-native-agent -->';
const TEMP_PREFIX = 'sidequest-native-';
const TICKET_PREFIX = 'sidequest-ticket-';

const NON_MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const RESTART_NOTICE = 'Executor definitions register within minutes. Wait for `New agent types are now available: <name>` before spawning; premature per-ticket spawns silently run generic agents and their token-gated claim refuses. If registration lags, use the stable pre-provisioned executor. Verify with transcript/meta.json and the token claim, never self-report.';

// Effort-scaled hard caps stamped into every executor definition's `maxTurns`
// frontmatter — the one FIRST-CLASS harness-enforced limit on a subagent run
// ("maximum number of agentic turns before the subagent stops"). Generous
// enough that a legitimately-scoped atomic ticket never hits the cap, tight
// enough that an unbounded wander does. Complements (does not replace) the
// SubagentStop wall-clock tripwire: maxTurns bounds turns, not minutes.
const EXEC_MAX_TURNS = { low: 25, medium: 40, high: 60, xhigh: 80, max: 80 };

// The cap for one effort tier. SIDEQUEST_EXEC_MAX_TURNS, when set to a positive
// integer, overrides ALL tiers; garbage or non-positive values are ignored and
// the effort default applies. Read at render time so a sync pass sees the
// current environment.
function execMaxTurns(effort) {
  const raw = process.env.SIDEQUEST_EXEC_MAX_TURNS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return EXEC_MAX_TURNS[effort] || EXEC_MAX_TURNS.medium;
}

// Where generated exec agents go. In production that's the user's live
// ~/.claude/agents (Claude Code loads them from there). But a test or isolated
// server sets SIDEQUEST_HOME to a throwaway dir, and it must NOT pollute the
// real agents dir: when SIDEQUEST_HOME is set we target <home>/agents instead,
// so an isolated server's PUT can never write into the developer's live agents.
// SIDEQUEST_AGENTS_DIR is an explicit override that wins over both.
function defaultAgentsDir() {
  const explicit = process.env.SIDEQUEST_AGENTS_DIR;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const home = process.env.SIDEQUEST_HOME;
  if (home && String(home).trim()) return path.join(path.resolve(String(home).trim()), 'agents');
  return path.join(os.homedir(), '.claude', 'agents');
}

function agentFileName(source, slug, effort, namespace) {
  const prefix = namespace ? `${source}-` : '';
  return `sidequest-exec-${prefix}${slug}-${effort}.md`;
}

// Render one agent file's full source from the shared template. Every runtime
// file is user-scoped rather than plugin-scoped so Claude Code honors its
// permissionMode: bypassPermissions frontmatter. `name` and `effort` are
// required; `modelId`, `marker`, and `extraNote` are optional.
function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .split('{{NAME}}').join(String(name))
    .split('{{EFFORT}}').join(String(effort))
    .split('{{MODEL_FRONTMATTER}}').join(modelId ? `\nmodel: ${modelId}` : '')
    .split('{{MAX_TURNS}}').join(String(execMaxTurns(String(effort))))
    .split('{{MARKER}}').join(marker || '')
    .split('{{EXTRA_NOTE}}').join(extraNote || '')
    .split('{{TICKET_BRIEF}}').join(ticketBrief || '');
}

// A single-line (one-paragraph) note appended to a Codex-backed agent's body:
// its effort is set via Claude Code's frontmatter, which the codex-gateway shim
// forwards to the Codex backend's reasoning.effort — so unlike an earlier read,
// effort DOES reach the model. The note records which real model runs.
function backendNote(slug, id) {
  const runtime = id || slug;
  return `\n\n_This agent is the authoritative Sidequest executor for the \`${slug}\` runtime and runs on \`${runtime}\` through codex-gateway. Claude Code's native suffix is external metadata; the Sidequest route line and this backend-specific executor name are authoritative. The \`effort\` frontmatter above is forwarded to the model's reasoning effort._`;
}

function renderBackendAgent(source, slug, id, effort, namespace) {
  const prefix = namespace ? `${source}-` : '';
  return renderExecAgent({
    name: `sidequest-exec-${prefix}${slug}-${effort}`,
    effort,
    modelId: id,
    marker: MARKER,
    extraNote: backendNote(slug, id),
  });
}

function refToken(ref) {
  return String(ref || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
}

// Turn a resolved runtime (resolveExec's runsModel / slug, e.g.
// "codex-gpt-5-6-luna" or the Claude alias "opus") into a filesystem-safe
// DISPLAY token for the agent name: drop the noisy "codex-" catalog prefix so
// the subagent card reads `gpt-5-6-luna`, and reduce to lowercase [a-z0-9-].
// Returns '' when there's no runtime to show.
function runtimeToken(runtime) {
  return String(runtime || '')
    .toLowerCase()
    .replace(/^codex-/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Name the temporary native executor after the runtime it actually runs, so
// Claude Code's subagent card shows the model (e.g.
// sidequest-native-sq-198-gpt-5-6-luna) instead of a meaningless hex nonce. The
// name STAYS TEMP_PREFIX-prefixed so cleanupNativeAgents still finds it, and the
// runtime token is a display label only — routing ids stay neutral. A short hex
// nonce is appended only to break a same-runtime collision for the same ref
// (createNativeAgent supplies one when the base name is already on disk).
function nativeAgentName(ref, runtime, nonce) {
  const ticket = refToken(ref);
  const token = runtimeToken(runtime);
  const base = token ? `${TEMP_PREFIX}${ticket}-${token}` : `${TEMP_PREFIX}${ticket}`;
  if (nonce == null || nonce === '') return base;
  const suffix = String(nonce).toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(suffix)) throw new Error('native agent nonce must be 6-32 lowercase alphanumeric characters.');
  return `${base}-${suffix}`;
}

function ticketExecutorName(ref, runtime) {
  const ticket = refToken(ref);
  const token = runtimeToken(runtime);
  return token ? `${TICKET_PREFIX}${ticket}-${token}` : `${TICKET_PREFIX}${ticket}`;
}

function temporaryAgentFile(name, dir) {
  if (!String(name || '').startsWith(TEMP_PREFIX) && !String(name || '').startsWith(TICKET_PREFIX)) {
    throw new Error('temporary agent name must use a Sidequest temporary prefix.');
  }
  return path.join(dir || defaultAgentsDir(), `${name}.md`);
}

function nativeAgentSource(spec) {
  const tools = Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'SendMessage'];
  if (!tools.every((tool) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tool)))) throw new Error('native agent tools must be valid tool names.');
  const model = String(spec.modelId || '').trim();
  const effort = String(spec.effort || '').trim();
  const runtime = String(spec.runtime || spec.runsModel || '').trim();
  if (!model || /[\r\n]/.test(model)) throw new Error('native agent model id is required and must be one line.');
  if (!NON_MAX_EFFORTS.includes(effort)) throw new Error(`native agent effort must be one of: ${NON_MAX_EFFORTS.join(', ')}.`);
  if (!runtime || /[\r\n]/.test(runtime)) throw new Error('native agent runtime must be a concrete one-line model identifier.');
  const session = String(spec.sessionId || '').replace(/[\r\n]/g, '');
  return [
    '---',
    `name: ${spec.name}`,
    'description: Temporary Sidequest native executor. Removed after this run.',
    `model: ${model}`,
    `effort: ${effort}`,
    `tools: ${tools.join(', ')}`,
    'permissionMode: bypassPermissions',
    '---',
    TEMP_MARKER,
    `<!-- sidequest-native-session: ${session} -->`,
    `<!-- sidequest-native-runtime: ${runtime} -->`,
    'You are a temporary Sidequest executor. Follow the exact task prompt from your parent. Stay within its ticket scope, verify the requested behavior, and report concise evidence. The parent owns orchestration. Before ending after success or failure, run the cleanup command supplied in your task prompt.',
    '',
  ].join('\n');
}

// Claude Code sees user-scoped agent definitions without a plugin rebuild. The
// short synchronous debounce lets its watcher register the new definition before
// the caller invokes Agent; tests pass waitMs: 0.
function waitForNativeAgentReload(waitMs) {
  const ms = Number.isFinite(Number(waitMs)) ? Math.max(0, Number(waitMs)) : 175;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ticketCommentsDigest(comments) {
  if (!Array.isArray(comments) || !comments.length) return '(No ticket comments were recorded.)';
  return comments.map((comment) => {
    const by = comment && comment.by ? ` by ${comment.by}` : '';
    const body = comment && comment.body ? comment.body : String(comment || '');
    return `- Comment${by}: ${body}`;
  }).join('\n');
}

function ticketBrief(ticket, nonce) {
  const category = ticket.category || {};
  const parts = [
    '',
    '## This ticket',
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || '(Untitled ticket)'}`,
    `Description:\n${ticket.description || '(No additional description was recorded.)'}`,
    `Anchors:\n${ticket.executorAnchors || '(No anchors were recorded.)'}`,
    `Verify command:\n${ticket.executorVerify || '(No exact verify command was recorded.)'}`,
    `Comments digest:\n${ticketCommentsDigest(ticket.comments)}`,
    `Category executor instructions:\n${category.contract || '(No category-specific executor instructions were recorded.)'}`,
    'Dispatch claim guard:',
    `Claim this ticket with \`--token ${nonce}\`. A token refusal means this agent was spawned before its definition registered or is not the prepared dispatch. Stop and report that refusal.`,
  ];
  return parts.join('\n\n');
}

function createTicketExecutor(ticket, opts) {
  opts = opts || {};
  if (!ticket || !ticket.ref || !ticket.model || !ticket.effort) throw new Error('ticket executor requires a routable ticket.');
  const nonce = String(opts.nonce || '').trim();
  if (!nonce || /[\r\n]/.test(nonce)) throw new Error('ticket executor nonce is required and must be one line.');
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.runsModel) throw new Error(`ticket executor could not resolve ${ticket.model} at ${ticket.effort}.`);
  const dir = opts.dir || defaultAgentsDir();
  const name = ticketExecutorName(ticket.ref, resolved.runsModel);
  const file = temporaryAgentFile(name, dir);
  const sessionId = String(opts.sessionId || '').replace(/[\r\n]/g, '');
  const source = renderExecAgent({
    name,
    effort: ticket.effort,
    modelId: resolved.backend === 'codex' ? resolved.spawnId : null,
    marker: TEMP_MARKER,
    extraNote: `\n<!-- sidequest-native-session: ${sessionId} -->\n<!-- sidequest-native-runtime: ${resolved.runsModel} -->`,
    ticketBrief: ticketBrief(ticket, nonce),
  });
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file, 'utf8');
    if (!previous.includes(TEMP_MARKER)) throw new Error(`ticket executor file already exists and is not owned by Sidequest: ${file}`);
  }
  fs.writeFileSync(file, source);
  waitForNativeAgentReload(opts.waitMs);
  return {
    name,
    file,
    spawn: { subagent_type: name, name, mode: 'bypassPermissions' },
    cleanup: { name, sessionId: opts.sessionId || null },
  };
}

function createNativeAgent(spec, opts) {
  opts = opts || {};
  spec = spec || {};
  // The stable route remains the default until orchestration deliberately opts
  // into a ticket-specific definition. It stays available while the watcher is
  // registering a new temporary definition.
  if (spec.agentType) {
    const name = nativeAgentName(spec.ref, spec.runtime, spec.nonce);
    const model = spec.spawnModel == null ? null : String(spec.spawnModel).trim();
    return {
      name,
      file: null,
      fallback: true,
      spawn: Object.assign({
        subagent_type: String(spec.agentType),
        name,
        mode: 'bypassPermissions',
      }, model ? { model } : {}),
      cleanup: { name, sessionId: spec.sessionId || null },
    };
  }
  const dir = opts.dir || defaultAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  // The runtime label (resolveExec's runsModel, which is the catalog slug for a
  // Codex tier or the Claude alias for a Claude tier) is what makes the name
  // readable. An explicit spec.nonce forces that suffix; otherwise the name is
  // the bare runtime-labeled base and a nonce is added only on collision.
  const runtime = spec.runtime != null ? spec.runtime : spec.runsModel;
  const explicitNonce = spec.nonce != null ? spec.nonce : null;
  let name = nativeAgentName(spec.ref, runtime, explicitNonce);
  if (explicitNonce == null && fs.existsSync(temporaryAgentFile(name, dir))) {
    // A same-runtime name for the same ref already exists on disk — disambiguate.
    name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString('hex'));
  }
  let file = temporaryAgentFile(name, dir);
  for (let attempt = 0; ; attempt++) {
    const source = nativeAgentSource(Object.assign({}, spec, { name }));
    try {
      fs.writeFileSync(file, source, { flag: 'wx' });
      break;
    } catch (err) {
      // Lost a create race against a parallel worker: try a fresh nonce. Only
      // when we own the nonce (no explicit one was pinned by the caller).
      if (err && err.code === 'EEXIST' && explicitNonce == null && attempt < 25) {
        name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString('hex'));
        file = temporaryAgentFile(name, dir);
        continue;
      }
      throw err;
    }
  }
  waitForNativeAgentReload(opts.waitMs);
  return {
    name,
    file,
    spawn: {
      subagent_type: name,
      name,
      mode: 'bypassPermissions',
    },
    cleanup: { name, sessionId: spec.sessionId || null },
  };
}

function cleanupNativeAgents(opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const name = opts.name ? String(opts.name) : null;
  const sessionId = opts.sessionId == null ? null : String(opts.sessionId);
  let removed = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => (f.startsWith(TEMP_PREFIX) || f.startsWith(TICKET_PREFIX)) && f.endsWith('.md')); } catch (_) { return { removed }; }
  for (const fileName of files) {
    if (name && fileName !== `${name}.md`) continue;
    const file = path.join(dir, fileName);
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (!source.includes(TEMP_MARKER)) continue;
    if (sessionId && !source.includes(`<!-- sidequest-native-session: ${sessionId} -->`)) continue;
    if (opts.staleBefore != null) {
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (stat.mtimeMs >= Number(opts.staleBefore)) continue;
    }
    try { fs.unlinkSync(file); removed++; } catch (_) { /* best effort */ }
  }
  return { removed };
}

// Sync executors for each configured concrete category route and fallback. A missing prefs
// object (or routing explicitly disabled) retains the generic files for manual
// dispatch. The MARKER lifecycle below remains responsible for stale cleanup.
function syncExecAgents(_prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const wanted = new Map();
  const routes = [];
  for (const pair of store.getCategoryRoutePairs()) {
    routes.push(pair.route);
    if (pair.fallback) routes.push(pair.fallback);
  }
  const globalFallback = store.getRoutingFallback();
  if (globalFallback) routes.push(globalFallback);
  for (const route of routes) {
    if (!route) continue;
    const resolved = store.resolveExec(route.model, route.effort);
    if (!resolved || !resolved.agent || wanted.has(`${resolved.agent}.md`)) continue;
    const content = resolved.backend === 'codex'
      ? renderBackendAgent(resolved.source, resolved.slug, resolved.spawnId, route.effort, resolved.agent !== `sidequest-exec-${resolved.slug}-${route.effort}`)
      : renderExecAgent({ name: resolved.agent, effort: route.effort, marker: MARKER });
    wanted.set(`${resolved.agent}.md`, content);
  }

  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch (_) {
    existing = [];
  }

  let written = 0;
  let removed = 0;
  let unchanged = 0;

  for (const [filename, content] of wanted) {
    const filePath = path.join(dir, filename);
    let prev = null;
    try {
      prev = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      prev = null;
    }
    // A file already sitting at this path that ISN'T ours (no marker) is left
    // completely alone, even though its name matches what we'd generate.
    if (prev !== null && !prev.includes(MARKER)) continue;
    if (prev === content) {
      unchanged++;
      continue;
    }
    fs.writeFileSync(filePath, content);
    written++;
  }

  const wantedNames = new Set(wanted.keys());
  for (const filename of existing) {
    if (wantedNames.has(filename)) continue;
    const filePath = path.join(dir, filename);
    let body = null;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      continue;
    }
    if (body == null || !body.includes(MARKER)) continue; // never delete an unmarked file
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (_) {
      /* best effort */
    }
  }

  return { written, removed, unchanged };
}

module.exports = {
  MARKER,
  TEMP_MARKER,
  TEMP_PREFIX,
  TICKET_PREFIX,
  NON_MAX_EFFORTS,
  RESTART_NOTICE,
  EXEC_MAX_TURNS,
  execMaxTurns,
  agentFileName,
  renderExecAgent,
  createTicketExecutor,
  createNativeAgent,
  cleanupNativeAgents,
  nativeAgentName,
  nativeAgentSource,
  syncExecAgents,
  defaultAgentsDir,
};
