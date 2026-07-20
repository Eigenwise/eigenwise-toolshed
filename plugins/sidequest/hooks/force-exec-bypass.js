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

function fallbackClassify(type) {
  const match = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
  if (match) return { kind: 'codex_dispatch', effort: match[1] };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type) {
  try {
    return require(path.join(pluginRoot(), 'lib', 'exec-names.js')).classify(type);
  } catch (_) {
    return fallbackClassify(type);
  }
}

function isCurrentExecutor(classification) {
  return classification.kind === 'claude_builtin' || classification.kind === 'codex_dispatch';
}

function agentDenyReason(type) {
  if (type.startsWith('sidequest-')) {
    return `sidequest: ${type} is not a recognized ticket executor — gate/executor version mismatch — update+reload sidequest, do not respawn or re-dispatch.`;
  }
  return `sidequest: ${type || 'custom'} is a generic Agent, not a Sidequest ticket executor. ` +
    'For a tiny lookup, use Read, Glob, Grep, or WebFetch inline. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor.';
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
  const matches = [...prompt.matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? (match[1] || match[2] || null) : null;
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function extractDispatchToken(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] : null;
}

function dispatchLaunches(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const section = prompt.slice(match.index, headings[index + 1] ? headings[index + 1].index : prompt.length);
    return { ref: match[1].toUpperCase(), token: extractDispatchToken(section) };
  }).filter((launch) => launch.token);
  if (launches.length) return launches;

  const refs = extractRefs(prompt);
  const tokens = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1]);
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0], token: tokens[0] }] : [];
}

function dispatchAgentName(input) {
  const toolInput = input && input.tool_input;
  const refs = extractRefs(toolInput && toolInput.prompt);
  const token = extractDispatchToken(toolInput && toolInput.prompt);
  if (refs.length !== 1 || !token) return null;
  return `sidequest-${refs[0].toLowerCase()}-${token.slice(0, 12)}`;
}

function recordAuthoritativeLaunch(input, type, agentName) {
  const toolInput = input && input.tool_input;
  const prompt = toolInput && toolInput.prompt;
  const launches = dispatchLaunches(prompt);
  const projectArg = extractProjectArg(prompt) || input.cwd || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (!launches.length || !projectArg || !sessionId) return;
  try {
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const found = store.findProject(projectArg);
    if (!found.ok) return;
    for (const launch of launches) {
      store.recordDispatchLaunch(found.slug, launch.ref, {
        token: launch.token,
        executor: type,
        sessionId,
        agentName: agentName || toolInput.name,
      });
    }
  } catch (_) {
    // A launch ledger must never block the Agent call.
  }
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

function dispatchRouteMarkers(input) {
  const prompt = input && input.tool_input && input.tool_input.prompt;
  if (typeof prompt !== 'string' || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1], effort: match[2] }));
}

function expectedDispatchDescription(input) {
  const prompt = input && input.tool_input && input.tool_input.prompt;
  const launches = dispatchLaunches(prompt);
  if (launches.length !== 1) return null;
  const projectArg = extractProjectArg(prompt) || input.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!projectArg) return null;
  try {
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const found = store.findProject(projectArg);
    if (!found.ok) return null;
    const ticket = store.getTicket(found.slug, launches[0].ref);
    if (!ticket || ticket.dispatchNonce !== launches[0].token) return null;
    const description = ticket.dispatch && ticket.dispatch.description;
    return typeof description === 'string' && description ? description : null;
  } catch (_) {
    return null;
  }
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
  const classification = classifyExecutor(type);
  if (!isCurrentExecutor(classification)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: agentDenyReason(type),
      },
    }));
    return;
  }

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
  const expectedDescription = expectedDispatchDescription(input);
  if (expectedDescription && toolInput.description !== expectedDescription) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `sidequest: dispatch description must match the prepared spawn. Re-run dispatch and pass its spawn unchanged. Expected description: ${expectedDescription}`,
      },
    }));
    return;
  }
  const launchAgentName = dispatchAgentName(input);
  if (launchAgentName) updatedInput.name = launchAgentName;

  if (classification.kind === 'codex_dispatch') {
    const markers = dispatchRouteMarkers(input);
    const routeModels = [...new Set(markers.map((marker) => marker.model))];
    if (!routeModels.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged.',
        },
      }));
      return;
    }
    const mismatch = markers.find((marker) => marker.effort !== classification.effort);
    if (mismatch) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `sidequest: dispatch executor effort "${classification.effort}" does not match route marker effort "${mismatch.effort}". Re-run dispatch and pass the returned spawn unchanged.`,
        },
      }));
      return;
    }
    const conflict = routeModels.length > 1 ? routeModels : null;
    if (conflict) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `sidequest: this batch mixes tickets stamped with different models (${conflict.join(', ')}) under one ` +
            `dispatch executor — every ticket would silently run on the last route marker's model. Split the batch ` +
            `per model and re-spawn each with its own dispatch prompt.`,
        },
      }));
      return;
    }
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, 'model');
    if (hadModel) delete updatedInput.model;
    recordAuthoritativeLaunch(input, type, launchAgentName);
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
      recordAuthoritativeLaunch(input, type, launchAgentName);
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
    recordAuthoritativeLaunch(input, type, launchAgentName);
    process.stdout.write(JSON.stringify({
      systemMessage: `sidequest: ${type} was spawned with model "${toolInput.model}" but ${res.refs.join(', ')} resolves to "${res.model}" — kept the caller's value; confirm the cap is deliberate.`,
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    }));
    return;
  }
  recordAuthoritativeLaunch(input, type, launchAgentName);
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
