import { isRecord, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeDeny, writeJson } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const PASS_THROUGH_AGENT_TYPES = new Set(['Explore', 'claude-code-guide', 'statusline-setup']);

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}
interface DispatchLaunch {
  ref: string;
  token: string;
}
interface ResolveResult {
  status: 'no-refs' | 'error' | 'no-project' | 'ticket-not-found' | 'ticket-not-builtin' | 'conflicting' | 'ok';
  refs: string[];
  missing?: string;
  ref?: string;
  models?: string[];
  model?: string;
}
interface Ticket {
  exec?: { model?: string };
  dispatchNonce?: string;
  dispatch?: {
    description?: string;
    route?: { model?: string; effort?: string; marker?: string };
  };
}
interface PreparedDispatchSpawn {
  description: string | null;
  name: string;
  ref: string;
  token: string;
  project: string;
  route: { model: string; effort: string; marker: string | null } | null;
}
interface PreparedDispatchValidation {
  status: 'none' | 'stale' | 'valid';
  spawn?: PreparedDispatchSpawn;
}
interface Store {
  findProject: (project: string) => { ok: boolean; slug?: string };
  getTicket: (slug: string, ref: string) => Ticket | null;
  recordDispatchLaunch: (slug: string, ref: string, options: Record<string, unknown>) => unknown;
}

function fallbackClassify(type: string): ExecutorClassification {
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

function isCurrentExecutor(classification: ExecutorClassification): boolean {
  return classification.kind === 'claude_builtin' || classification.kind === 'codex_dispatch';
}

function isExecutorCaller(input: HookInput): boolean {
  if (!stringField(input, 'agent_id')) return false;
  const type = stringField(input, 'agent_type');
  if (!type) return false;
  return isCurrentExecutor(classifyExecutor(type))
    || type.startsWith('sidequest-sq-')
    || type.startsWith('sidequest-ticket-')
    || type.startsWith('sidequest-native-');
}

function agentDenyReason(type: string): string {
  if (type.startsWith('sidequest-')) {
    return `sidequest: ${type} is not a recognized ticket executor — gate/executor version mismatch — update+reload sidequest, do not respawn or re-dispatch.`;
  }
  return `sidequest: ${type || 'custom'} is a generic Agent, not a Sidequest ticket executor. ` +
    'For a tiny lookup, use Read, Glob, Grep, or WebFetch inline. Any delegated work, including a quick investigation, needs a ticket: file a spike (usually codebase-exploration), route it, dispatch it, then spawn the returned executor.';
}

const REF_RE = /\bSQ-\d+\b/gi;

function extractRefs(prompt: unknown): string[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of prompt.match(REF_RE) || []) {
    const ref = match.toUpperCase();
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function extractProjectArg(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}

function extractDispatchToken(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt) return null;
  const matches = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || null : null;
}

function dispatchLaunches(prompt: unknown): DispatchLaunch[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const headings = [...prompt.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const launches = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = prompt.slice(match.index, next ? next.index : prompt.length);
    return { ref: (match[1] || '').toUpperCase(), token: extractDispatchToken(section) };
  }).filter((launch): launch is DispatchLaunch => Boolean(launch.ref && launch.token));
  if (launches.length) return launches;

  const refs = extractRefs(prompt);
  const tokens = [...prompt.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1] || '');
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] || '' }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0] || '', token: tokens[0] || '' }] : [];
}

function toolInputOf(input: HookInput): Record<string, unknown> | null {
  return isRecord(input.tool_input) ? input.tool_input : null;
}

function dispatchAgentName(input: HookInput): string | null {
  const toolInput = toolInputOf(input);
  const refs = extractRefs(toolInput?.prompt);
  const token = extractDispatchToken(toolInput?.prompt);
  if (refs.length !== 1 || !token) return null;
  return `sidequest-${(refs[0] || '').toLowerCase()}-${token.slice(0, 12)}`;
}

function recordAuthoritativeLaunch(input: HookInput, type: string, agentName: string | null): void {
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = extractProjectArg(toolInput.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (!launches.length || !projectArg || !sessionId) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(projectArg);
    if (!found.ok || !found.slug) return;
    for (const launch of launches) {
      store.recordDispatchLaunch(found.slug, launch.ref, {
        token: launch.token,
        executor: type,
        sessionId,
        agentName: agentName || toolInput.name,
      });
    }
  } catch (_) {}
}

function resolveStampedModel(input: HookInput): ResolveResult {
  const toolInput = toolInputOf(input);
  const prompt = toolInput?.prompt;
  const refs = extractRefs(prompt);
  if (!refs.length) return { status: 'no-refs', refs };

  let store: Store;
  try {
    store = require(runtimeModule('store')) as Store;
  } catch (_) {
    return { status: 'error', refs };
  }

  const projectArg = extractProjectArg(prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  const found = projectArg ? store.findProject(projectArg) : { ok: false };
  if (!found.ok || !found.slug) return { status: 'no-project', refs };

  const models = new Set<string>();
  for (const ref of refs) {
    const ticket = store.getTicket(found.slug, ref);
    if (!ticket) return { status: 'ticket-not-found', refs, missing: ref };
    if (!ticket.exec?.model) return { status: 'ticket-not-builtin', refs, ref };
    models.add(ticket.exec.model);
  }
  if (models.size !== 1) return { status: 'conflicting', refs, models: [...models] };
  return { status: 'ok', refs, model: [...models][0] };
}

const ROUTE_MARKER_RE = /^\[sidequest-route model=([a-z0-9][a-z0-9.-]{0,63}) effort=(low|medium|high|xhigh|max)\]$/gm;

function dispatchRouteMarkers(input: HookInput): Array<{ model: string; effort: string }> {
  const prompt = toolInputOf(input)?.prompt;
  if (typeof prompt !== 'string' || !prompt) return [];
  return [...prompt.matchAll(ROUTE_MARKER_RE)].map((match) => ({ model: match[1] || '', effort: match[2] || '' }));
}

function preparedDispatchValidation(input: HookInput): PreparedDispatchValidation {
  const toolInput = toolInputOf(input);
  if (!toolInput) return { status: 'none' };
  const launches = dispatchLaunches(toolInput.prompt);
  if (launches.length !== 1) return { status: 'none' };
  const launch = launches[0];
  const project = extractProjectArg(toolInput.prompt) || stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR;
  if (!launch || !project) return { status: 'none' };
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(project);
    if (!found.ok || !found.slug) return { status: 'none' };
    const ticket = store.getTicket(found.slug, launch.ref);
    if (!ticket) return { status: 'none' };
    if (ticket.dispatchNonce !== launch.token) return { status: 'stale' };
    const description = ticket.dispatch?.description;
    const route = ticket.dispatch?.route;
    return {
      status: 'valid',
      spawn: {
        description: typeof description === 'string' && description ? description : null,
        name: `sidequest-${launch.ref.toLowerCase()}-${launch.token.slice(0, 12)}`,
        ref: launch.ref,
        token: launch.token,
        project,
        route: typeof route?.model === 'string' && typeof route.effort === 'string'
          ? { model: route.model, effort: route.effort, marker: typeof route.marker === 'string' && route.marker ? route.marker : null }
          : null,
      },
    };
  } catch (_) {
    return { status: 'none' };
  }
}

function briefingCommandDrifted(prompt: unknown, spawn: PreparedDispatchSpawn): boolean {
  if (typeof prompt !== 'string' || !/FIRST action:\s*run/i.test(prompt)) return false;
  const command = /FIRST action:\s*run\s+`([^`]+)`/i.exec(prompt)?.[1];
  if (!command) return true;
  const refs = extractRefs(command);
  return !/sidequest-launcher\.js["']?\s+briefing\b/i.test(command)
    || refs.length !== 1
    || refs[0] !== spawn.ref
    || extractDispatchToken(command) !== spawn.token
    || extractProjectArg(command) !== spawn.project;
}

function correctionMessage(corrections: string[]): string | null {
  return corrections.length ? `sidequest: corrected prepared dispatch ${corrections.join(' and ')}.` : null;
}

function denyReason(result: ResolveResult, type: string): string {
  const retry = 'Re-read the wave (`ready --brief`) and re-spawn with `model: exec.model`.';
  const base = `sidequest: ${type} was spawned without \`model\` and it couldn't be resolved`;
  switch (result.status) {
    case 'no-refs':
      return `${base} — no SQ-\\d+ ticket ref was found in the prompt. ${retry}`;
    case 'no-project':
      return `${base} — the board for ${result.refs.join(', ')} couldn't be determined (no --project, cwd, or CLAUDE_PROJECT_DIR resolved to a registered board). ${retry}`;
    case 'ticket-not-found':
      return `${base} — ${result.missing} wasn't found on the resolved board. ${retry}`;
    case 'ticket-not-builtin':
      return `${base} — ${result.ref} resolves to a Codex route, which spawns its own pinned executor, not a builtin. Re-read the wave (\`ready --brief\`) and spawn its \`exec.agent\` instead.`;
    case 'conflicting':
      return `${base} — ${result.refs.join(', ')} resolve to conflicting concrete models (${(result.models || []).join(', ')}). That's an illegal mixed-model batch: split it per model and re-spawn each with its own \`model: exec.model\`.`;
    default:
      return `${base}. ${retry}`;
  }
}

function main(): void {
  const input = readStdin();
  if (!input) return;
  const toolInput = toolInputOf(input);
  if (!toolInput) return;
  const type = String(toolInput.subagent_type || '');
  if (PASS_THROUGH_AGENT_TYPES.has(type)) return;
  const classification = classifyExecutor(type);
  if (!isCurrentExecutor(classification)) {
    if (isExecutorCaller(input) && !type.startsWith('sidequest-')) {
      writeJson({
        systemMessage: 'sidequest: executor fan-out is allowed for this ticket. Spawn unnamed subagents only, keep them inside the ticket scope, and never file, route, or dispatch board tickets from an executor.',
      });
      return;
    }
    writeDeny('PreToolUse', agentDenyReason(type));
    return;
  }

  const subagentOverride = String(process.env.CLAUDE_CODE_SUBAGENT_MODEL || '').trim();
  if (subagentOverride) {
    writeDeny(
      'PreToolUse',
      `sidequest: CLAUDE_CODE_SUBAGENT_MODEL="${subagentOverride}" is set — it overrides every sidequest ` +
        `executor's routed model (a Codex route would silently run on a Claude model; builtins collapse to one ` +
        `route), defeating routing. Unset it before spawning sidequest executors.`,
    );
    return;
  }

  const updatedInput: Record<string, unknown> = { ...toolInput, mode: 'bypassPermissions' };
  const dispatchValidation = preparedDispatchValidation(input);
  if (dispatchValidation.status === 'stale') {
    writeDeny('PreToolUse', 'sidequest: dispatch token is stale or rotated. Re-run dispatch and pass its spawn unchanged.');
    return;
  }
  const preparedSpawn = dispatchValidation.spawn;
  if (preparedSpawn && briefingCommandDrifted(toolInput.prompt, preparedSpawn)) {
    writeDeny('PreToolUse', 'sidequest: dispatch briefing command must match the prepared spawn. Re-run dispatch and pass its spawn unchanged.');
    return;
  }
  const corrections: string[] = [];
  if (preparedSpawn?.description && toolInput.description !== preparedSpawn.description) {
    updatedInput.description = preparedSpawn.description;
    corrections.push('description');
  }
  if (preparedSpawn && toolInput.name !== preparedSpawn.name) {
    updatedInput.name = preparedSpawn.name;
    corrections.push('name');
  }
  const launchAgentName = preparedSpawn?.name || dispatchAgentName(input);
  if (launchAgentName) updatedInput.name = launchAgentName;
  const preparedCorrection = correctionMessage(corrections);

  if (classification.kind === 'codex_dispatch') {
    const markers = dispatchRouteMarkers(input);
    const routeModels = [...new Set(markers.map((marker) => marker.model))];
    // The prompt marker carries the gateway model form, so compare it against
    // route.marker (recorded at dispatch-prepare since 3.6.7), not the board
    // slug in route.model — those never match for codex routes. Falling back
    // to route.model keeps pre-3.6.7 prepared dispatches denied into the
    // "re-run dispatch" path, which records the marker.
    if (preparedSpawn?.route && markers.some((marker) =>
      marker.model !== (preparedSpawn.route?.marker ?? preparedSpawn.route?.model)
        || marker.effort !== preparedSpawn.route?.effort)) {
      writeDeny('PreToolUse', 'sidequest: dispatch route marker must match the prepared spawn. Re-run dispatch and pass the returned spawn unchanged.');
      return;
    }
    if (!routeModels.length) {
      writeDeny('PreToolUse', 'sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged.');
      return;
    }
    const mismatch = markers.find((marker) => marker.effort !== classification.effort);
    if (mismatch) {
      writeDeny('PreToolUse', `sidequest: dispatch executor effort "${classification.effort}" does not match route marker effort "${mismatch.effort}". Re-run dispatch and pass the returned spawn unchanged.`);
      return;
    }
    if (routeModels.length > 1) {
      writeDeny(
        'PreToolUse',
        `sidequest: this batch mixes tickets stamped with different models (${routeModels.join(', ')}) under one ` +
          `dispatch executor — every ticket would silently run on the last route marker's model. Split the batch ` +
          `per model and re-spawn each with its own dispatch prompt.`,
      );
      return;
    }
    const hadModel = Object.prototype.hasOwnProperty.call(toolInput, 'model');
    if (hadModel) delete updatedInput.model;
    recordAuthoritativeLaunch(input, type, launchAgentName);
    const messages = [
      preparedCorrection,
      hadModel ? `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` : null,
    ].filter((message): message is string => Boolean(message));
    writeJson({
      ...(messages.length ? { systemMessage: messages.join(' ') } : {}),
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    });
    return;
  }

  const hasModel = Object.prototype.hasOwnProperty.call(toolInput, 'model') && toolInput.model != null && toolInput.model !== '';
  if (!hasModel) {
    const result = resolveStampedModel(input);
    if (result.status === 'ok' && result.model) {
      updatedInput.model = result.model;
      recordAuthoritativeLaunch(input, type, launchAgentName);
      writeJson({
        systemMessage: [
          preparedCorrection,
          `sidequest: ${type} spawned without a model — injected "${result.model}" from ${result.refs.join(', ')}'s resolved category route. Always pass model: exec.model on Claude routes.`,
        ].filter(Boolean).join(' '),
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
      });
      return;
    }
    writeDeny('PreToolUse', denyReason(result, type));
    return;
  }

  const result = resolveStampedModel(input);
  if (result.status === 'ok' && result.model !== toolInput.model) {
    recordAuthoritativeLaunch(input, type, launchAgentName);
    writeJson({
      systemMessage: [
        preparedCorrection,
        `sidequest: ${type} was spawned with model "${String(toolInput.model)}" but ${result.refs.join(', ')} resolves to "${result.model}" — kept the caller's value; confirm the cap is deliberate.`,
      ].filter(Boolean).join(' '),
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
    });
    return;
  }
  recordAuthoritativeLaunch(input, type, launchAgentName);
  writeJson({
    ...(preparedCorrection ? { systemMessage: preparedCorrection } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
  });
}

try {
  main();
} catch (_) {
  process.exit(0);
}
