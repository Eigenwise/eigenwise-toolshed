'use strict';
/**
 * Force Sidequest ticket executors into bypass mode at the Agent-tool boundary.
 * Plugin agent frontmatter is not authoritative when the parent runs in auto
 * mode, so this hook updates the actual launch input before Claude Code creates
 * the subagent/worktree. Codex-backed and temporary native executors also pin
 * their real model in frontmatter. An Agent `model` field overrides that pin,
 * so remove it here before a caller can accidentally spend Claude usage.
 *
 * A BUILTIN executor (sidequest-exec-low|medium|high|xhigh|max) has no pin — an
 * omitted `model` silently inherits the expensive session model instead of the
 * ticket's routed model, defeating routing. This hook resolves the ticket
 * ref(s) named in the prompt and injects the stamped model, or denies the spawn
 * when it can't be resolved unambiguously.
 */

const fs = require('fs');
const path = require('path');

const BUILTIN_EXECUTORS = new Set([
  'sidequest-exec-low', 'sidequest-exec-medium', 'sidequest-exec-high',
  'sidequest-exec-xhigh', 'sidequest-exec-max',
]);

function isPinnedSidequestExecutor(type) {
  return type.startsWith('sidequest-native-')
    || (type.startsWith('sidequest-exec-') && !BUILTIN_EXECUTORS.has(type));
}

const REF_RE = /\bSQ-\d+\b/gi;

function extractRefs(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const seen = new Set();
  const out = [];
  for (const m of prompt.match(REF_RE) || []) {
    const ref = m.toUpperCase();
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function extractProjectArg(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  const m = prompt.match(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/);
  return m ? (m[1] || m[2] || null) : null;
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

// Resolve the ticket ref(s) named in a builtin executor's prompt to the single
// concrete Claude runtime their category route resolved to. lib/store.js is lazy-required
// here (not at module scope) so the hook's dominant traffic — non-sidequest agents, and
// any exec prompt with no SQ-ref to resolve — never pays for it.
function resolveStampedModel(input) {
  const prompt = input && input.tool_input && input.tool_input.prompt;
  const refs = extractRefs(prompt);
  if (!refs.length) return { status: 'no-refs', refs };

  let store;
  try {
    store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  } catch (_) {
    return { status: 'error', refs };
  }

  const projectArg = extractProjectArg(prompt) || input.cwd || process.env.CLAUDE_PROJECT_DIR;
  const found = projectArg ? store.findProject(projectArg) : { ok: false };
  if (!found.ok) return { status: 'no-project', refs };

  const models = new Set();
  for (const ref of refs) {
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket) return { status: 'ticket-not-found', refs, missing: ref };
    const exec = ticket.exec;
    if (!exec || !exec.model) return { status: 'ticket-not-builtin', refs, ref };
    models.add(exec.model);
  }
  if (models.size !== 1) return { status: 'conflicting', refs, models: [...models] };
  return { status: 'ok', refs, model: [...models][0] };
}

// A shared dispatch executor (sidequest-exec-dispatch-<effort>) runs the model
// named by the ONE route marker in its spawn prompt. The gateway uses the last
// marker it sees, so conflicting markers are the only batch shape that can
// silently run tickets on the wrong model. This mirrors the gateway marker grammar.
const ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)\]$/gm;

function dispatchBatchConflict(input) {
  const prompt = input && input.tool_input && input.tool_input.prompt;
  if (typeof prompt !== 'string' || !prompt) return null;
  const models = new Set();
  for (const match of prompt.matchAll(ROUTE_MARKER_RE)) models.add(match[1]);
  return models.size > 1 ? [...models] : null;
}

function denyReason(res, type) {
  const retry = 'Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.';
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (res.status) {
    case 'no-refs':
      return `${base} — no SQ-\\d+ ticket ref was found in the prompt. ${retry}`;
    case 'no-project':
      return `${base} — the board for ${res.refs.join(', ')} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case 'ticket-not-found':
      return `${base} — ${res.missing} wasn't found on the resolved board. ${retry}`;
    case 'ticket-not-builtin':
      return `${base} — ${res.ref} resolves to a Codex route, which spawns its own pinned executor, not a builtin. Re-read the wave (\`ready --brief\`) and spawn its \`exec.agent\` instead.`;
    case 'conflicting':
      return `${base} — ${res.refs.join(', ')} resolve to conflicting concrete models (${res.models.join(', ')}). That's an illegal mixed-model batch: split it per model and re-spawn each with its own \`model: exec.model\`.`;
    default:
      return `${base}. ${retry}`;
  }
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  const toolInput = input && input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return;
  const type = String(toolInput.subagent_type || '');
  const isExec = type.startsWith('sidequest-exec-') || type.startsWith('sidequest-native-');
  if (!isExec) return;

  // CLAUDE_CODE_SUBAGENT_MODEL overrides BOTH a per-invocation model AND the agent's
  // frontmatter pin (docs: model-config). Nothing this hook can edit wins over it:
  // for a pinned Codex/native executor it silently reroutes the ticket onto a Claude
  // model (wrong backend + Claude spend); for a builtin it collapses every route to
  // one model. Either way it defeats routing, so refuse the spawn rather than run it
  // on the wrong model.
  const subagentOverride = String(process.env.CLAUDE_CODE_SUBAGENT_MODEL || '').trim();
  if (subagentOverride) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `sidequest: CLAUDE_CODE_SUBAGENT_MODEL="${subagentOverride}" is set — it overrides every sidequest ` +
          `executor's routed model (a Codex route would silently run on a Claude model; builtins collapse to one ` +
          `route), defeating routing. Unset it before spawning sidequest executors.`,
      },
    }));
    return;
  }

  const updatedInput = { ...toolInput, mode: 'bypassPermissions' };

  if (isPinnedSidequestExecutor(type)) {
    if (type.startsWith('sidequest-exec-dispatch-')) {
      const conflict = dispatchBatchConflict(input);
      if (conflict) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `sidequest: this batch mixes tickets stamped with different models (${conflict.join(', ')}) under one ` +
              `dispatch executor — every ticket would silently run on the last route marker's model. Split the batch ` +
              `per model and re-spawn each with its own dispatch briefing.`,
          },
        }));
        return;
      }
    }
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, 'model');
    if (hadModel) delete updatedInput.model;
    process.stdout.write(JSON.stringify({
      ...(hadModel
        ? { systemMessage: `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` }
        : {}),
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    }));
    return;
  }

  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, 'model')
    && toolInput.model != null && toolInput.model !== '';

  if (!hasModel) {
    const res = resolveStampedModel(input);
    if (res.status === 'ok') {
      updatedInput.model = res.model;
      process.stdout.write(JSON.stringify({
        systemMessage: `sidequest: ${type} spawned without a model — injected "${res.model}" from ${res.refs.join(', ')}'s resolved category route. Always pass model: exec.model on Claude routes.`,
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
      }));
      return;
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(res, type),
      },
    }));
    return;
  }

  // Caller passed a model — deliberate capping is legit, so keep it. Still flag
  // an unnoticed divergence from the named ticket(s)' resolved concrete model.
  const res = resolveStampedModel(input);
  if (res.status === 'ok' && res.model !== toolInput.model) {
    process.stdout.write(JSON.stringify({
      systemMessage: `sidequest: ${type} was spawned with model "${toolInput.model}" but ${res.refs.join(', ')} resolves to "${res.model}" — kept the caller's value; confirm the cap is deliberate.`,
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
  }));
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated Agent launches.
  process.exit(0);
}
