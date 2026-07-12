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
 * VERIFIED FACT this module builds on: an agent FILE with a `model: <full-id>`
 * frontmatter key (e.g. "claude-codex-gpt-5.4[1m]") runs on that model through
 * the codex-gateway shim, and `claude -p --model <full-id>` does too. So every
 * tier the user has POINTED AT a discovered Codex model (prefs.tierBackend, e.g.
 * opus -> codex-gpt-5-6-terra) gets its own real agent file —
 * sidequest-exec-<slug>-<effort>.md, one per that tier's enabled non-max effort —
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
const discovery = require('./discovery.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'scripts', '_exec-template.md');

// Marks a file as ours. Must stay unique enough that no human-authored agent
// file would plausibly contain it verbatim.
const MARKER = '<!-- generated-by: sidequest-agentsync -->';

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

function agentFileName(slug, effort) {
  return `sidequest-exec-${slug}-${effort}.md`;
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

function renderBackendAgent(slug, id, effort) {
  return renderExecAgent({
    name: `sidequest-exec-${slug}-${effort}`,
    effort,
    modelId: id,
    marker: MARKER,
    extraNote: backendNote(slug, id),
  });
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
  for (const m of discovery.discoverExternalModels()) {
    if (!m || !m.slug || !m.id) continue;
    for (const effort of NON_MAX_EFFORTS) {
      wanted.set(agentFileName(m.slug, effort), renderBackendAgent(m.slug, m.id, effort));
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
  NON_MAX_EFFORTS,
  agentFileName,
  renderExecAgent,
  syncExecAgents,
  defaultAgentsDir,
};
