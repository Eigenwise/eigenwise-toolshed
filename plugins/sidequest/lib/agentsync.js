'use strict';
/**
 * sidequest - runtime exec agent sync for enabled discovered models (SQ-158)
 *
 * The five shipped sidequest-exec-<effort>.md agents (scripts/gen-exec-agents.js,
 * build time) give the orchestrator one Task-tool subagent_type per built-in
 * effort level, spawned at a chosen MODEL via the Agent tool's `model` param
 * (sonnet|opus|haiku|fable). That param does not accept an arbitrary model
 * string, so a discovered custom model (SQ-156/157, e.g. a codex-gateway tier)
 * has no way to ride it.
 *
 * VERIFIED FACT this module builds on: a registered agent FILE with a
 * `model: <full-id>` frontmatter pin (e.g. "claude-codex-gpt-5.6-terra[1m]")
 * genuinely runs on that model through the codex-gateway shim when spawned via
 * the native Agent tool with the `model` parameter OMITTED — the spawned agent
 * self-reports the GPT backend and the gateway's codex request counter
 * advances. Passing ANY Agent `model` value overrides the pin and silently
 * runs Anthropic instead, so dispatchers must leave the param out for Codex
 * routes (store.resolveExec advertises this as model: null with
 * dispatch: 'native-agent'). So every tier the user has POINTED AT a
 * discovered Codex model (prefs.tierBackend, e.g.
 * opus -> codex-gpt-5-6-terra) gets its own real agent file —
 * sidequest-exec-<source>-<slug>-<effort>.md, one per that tier's enabled
 * non-max effort —
 * with a `model:` frontmatter pin, generated into the user's live agents
 * directory (default ~/.claude/agents) at RUNTIME (the model wasn't known at
 * plugin build time; it's discovered from the user's machine).
 *
 * Both the build-time generator (scripts/gen-exec-agents.js) and this module's
 * syncExecAgents() render through the SAME scripts/_exec-template.md via
 * renderExecAgent() below, so the ticket-execution protocol body can never
 * drift between the shipped and the runtime-generated files.
 *
 * Lifecycle safety: every file this module writes starts with MARKER on its
 * own line. A sync pass writes/updates exactly the files the current prefs
 * call for, and removes any MARKER-bearing file in the target dir that no
 * longer corresponds to an enabled-custom x enabled-non-max-effort combo. A
 * file WITHOUT the marker — whether or not its name collides with one we'd
 * generate — is NEVER written, overwritten, or deleted; it isn't ours.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const discovery = require('./discovery.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'scripts', '_exec-template.md');

// Marks a file as ours. Must stay unique enough that no human-authored agent
// file would plausibly contain it verbatim.
const MARKER = '<!-- generated-by: sidequest-agentsync -->';
const TEMP_MARKER = '<!-- generated-by: sidequest-native-agent -->';
const TEMP_PREFIX = 'sidequest-native-';

// The effort axis a generated agent's frontmatter can pin — `max` is the
// sparing top rung (see store.js's routingLadder) and, like the five shipped
// agents, is never carried by an auto-generated exec agent.
const NON_MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

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
function renderExecAgent({ name, effort, modelId, marker, extraNote }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .split('{{NAME}}').join(String(name))
    .split('{{EFFORT}}').join(String(effort))
    .split('{{MODEL_FRONTMATTER}}').join(modelId ? `\nmodel: ${modelId}` : '')
    .split('{{MARKER}}').join(marker || '')
    .split('{{EXTRA_NOTE}}').join(extraNote || '');
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

function nativeAgentFile(name, dir) {
  if (!String(name || '').startsWith(TEMP_PREFIX)) throw new Error('native agent name must use the Sidequest temporary prefix.');
  return path.join(dir || defaultAgentsDir(), `${name}.md`);
}

function nativeAgentSource(spec) {
  const tools = Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'SendMessage'];
  if (!tools.every((tool) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tool)))) throw new Error('native agent tools must be valid tool names.');
  const model = String(spec.modelId || '').trim();
  const effort = String(spec.effort || '').trim();
  const grade = String(spec.grade || '').trim();
  if (!model || /[\r\n]/.test(model)) throw new Error('native agent model id is required and must be one line.');
  if (!NON_MAX_EFFORTS.includes(effort)) throw new Error(`native agent effort must be one of: ${NON_MAX_EFFORTS.join(', ')}.`);
  if (!/^grade-[1-4]$/.test(grade)) throw new Error('native agent grade must be a neutral grade-1 through grade-4 identifier.');
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
    `<!-- sidequest-native-grade: ${grade} -->`,
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

function createNativeAgent(spec, opts) {
  opts = opts || {};
  spec = spec || {};
  // Claude Code snapshots the user-agent registry when the session starts. A
  // definition written mid-session can appear in a later agent listing yet still
  // be rejected by Agent as unknown. Route native dispatch through the stable,
  // session-start-provisioned executor instead. Keep a unique display name so
  // concurrent ticket cards remain distinguishable, but do not create a stale
  // temporary definition that Agent cannot resolve.
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
  if (explicitNonce == null && fs.existsSync(nativeAgentFile(name, dir))) {
    // A same-runtime name for the same ref already exists on disk — disambiguate.
    name = nativeAgentName(spec.ref, runtime, crypto.randomBytes(4).toString('hex'));
  }
  let file = nativeAgentFile(name, dir);
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
        file = nativeAgentFile(name, dir);
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
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(TEMP_PREFIX) && f.endsWith('.md')); } catch (_) { return { removed }; }
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

// Regenerate the runtime Codex exec agents. The wanted set is a pure function of
// the DISCOVERED Codex catalog (discovery.js), NOT of the tier mapping or the
// effort allowlist: an agent file is keyed by model slug + effort, and any
// discovered model can be pointed at any tier at any enabled effort at runtime.
// So we write one file per discovered model x every non-max effort — the files
// exist on disk BEFORE the user maps anything, which is what lets Claude Code
// register them at session start and lets a later mapping change spawn an
// already-present agent with NO manual sync and NO restart. That's why the
// SessionStart hook calls this on every session: the files are persistent
// artifacts that outlive a session, so once a model has been discovered in any
// prior session its agents are already registered.
//
// Written into `dir` (default ~/.claude/agents; tests must always override this,
// never point it at a real home directory). With no catalog (codex-gateway not
// installed) the wanted set is empty: nothing is written and any stale marked
// files are removed. Idempotent. `prefs` is accepted for call-site compatibility
// but no longer affects the output. Returns { written, removed, unchanged }.
function syncExecAgents(prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();

  const wanted = new Map(); // filename -> rendered content
  // Plugin subagents ignore permissionMode frontmatter. Mirror the built-in
  // executors into the user's agent directory so their bypass policy is active.
  for (const effort of [...NON_MAX_EFFORTS, 'max']) {
    wanted.set(`sidequest-exec-${effort}.md`, renderExecAgent({
      name: `sidequest-exec-${effort}`,
      effort,
      marker: MARKER,
    }));
  }
  const models = discovery.discoverExternalModels().filter((m) => m && m.slug && m.id);
  const duplicateSlugs = new Set();
  const seenSlugs = new Set();
  for (const m of models) {
    if (seenSlugs.has(m.slug)) duplicateSlugs.add(m.slug);
    seenSlugs.add(m.slug);
  }
  for (const m of models) {
    for (const effort of NON_MAX_EFFORTS) {
      const namespace = duplicateSlugs.has(m.slug);
      wanted.set(agentFileName(m.source, m.slug, effort, namespace), renderBackendAgent(m.source, m.slug, m.id, effort, namespace));
    }
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
  NON_MAX_EFFORTS,
  agentFileName,
  renderExecAgent,
  createNativeAgent,
  cleanupNativeAgents,
  nativeAgentName,
  nativeAgentSource,
  syncExecAgents,
  defaultAgentsDir,
};
