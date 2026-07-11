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
 * ENABLED custom model tier gets its own real agent file —
 * sidequest-exec-<slug>-<effort>.md, one per enabled non-max effort — with a
 * `model:` frontmatter pin, generated into the user's live agents directory
 * (default ~/.claude/agents) at RUNTIME (the model wasn't known at plugin
 * build time; it's discovered from the user's machine).
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
const store = require('./store.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'scripts', '_exec-template.md');

// Marks a file as ours. Must stay unique enough that no human-authored agent
// file would plausibly contain it verbatim.
const MARKER = '<!-- generated-by: sidequest-agentsync -->';

// The effort axis a generated agent's frontmatter can pin — `max` is the
// sparing top rung (see store.js's routingLadder) and, like the five shipped
// agents, is never carried by an auto-generated exec agent.
const NON_MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function defaultAgentsDir() {
  return path.join(os.homedir(), '.claude', 'agents');
}

function agentFileName(slug, effort) {
  return `sidequest-exec-${slug}-${effort}.md`;
}

// Render one agent file's full source from the shared template. `name` and
// `effort` are required; `modelId`, `marker`, and `extraNote` are optional and
// each default to a no-op (empty) substitution — which is exactly what lets
// the build-time generator reuse this same function and still emit the
// byte-identical five shipped files it always has.
function renderExecAgent({ name, effort, modelId, marker, extraNote }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .split('{{NAME}}').join(String(name))
    .split('{{EFFORT}}').join(String(effort))
    .split('{{MODEL_FRONTMATTER}}').join(modelId ? `\nmodel: ${modelId}` : '')
    .split('{{MARKER}}').join(marker || '')
    .split('{{EXTRA_NOTE}}').join(extraNote || '');
}

// A single-line (one-paragraph) advisory appended to a custom agent's body:
// reasoning effort is only enforced via Claude Code's own frontmatter/agent
// machinery, which a gateway-routed model doesn't necessarily honor the same
// way a native Claude tier does.
function advisoryNote(custom) {
  return `\n\n_Advisory note: this agent targets the \`${custom.slug}\` model tier (\`${custom.id}\`), routed through a gateway plugin — the \`effort\` frontmatter above is advisory on gateway models; it does not control the underlying model's own reasoning depth the way it does for a native Claude tier._`;
}

function renderCustomAgent(custom, effort) {
  return renderExecAgent({
    name: `sidequest-exec-${custom.slug}-${effort}`,
    effort,
    modelId: custom.id,
    marker: MARKER,
    extraNote: advisoryNote(custom),
  });
}

// Regenerate the runtime exec agents for every ENABLED custom model tier
// (SQ-156/157's resolved prefs.custom, via getModelVocab) crossed with every
// enabled non-max effort in that model's own effort row, into `dir` (default
// ~/.claude/agents; tests must always override this — never point it at a
// real home directory).
//
// Idempotent: re-running with the same prefs writes nothing new (already-
// correct files are left untouched and counted as `unchanged`). Disabling a
// model, or turning off one of its efforts, removes exactly the files that
// combo no longer covers on the next sync. Returns { written, removed,
// unchanged }.
function syncExecAgents(prefs, opts) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const vocab = store.getModelVocab(prefs);

  const wanted = new Map(); // filename -> rendered content
  for (const custom of vocab.customs) {
    if (!custom.enabled) continue;
    for (const effort of NON_MAX_EFFORTS) {
      if (custom.efforts && custom.efforts[effort] === false) continue;
      wanted.set(agentFileName(custom.slug, effort), renderCustomAgent(custom, effort));
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
