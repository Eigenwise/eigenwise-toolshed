'use strict';
/**
 * sidequest - runtime exec agent sync (SQ-158)
 *
 * syncExecAgents() generates the complete stable executor ladder for both Claude
 * and Codex dispatch, independent of the live routing taxonomy. Each file is
 * marked as owned by Sidequest. Reconciliation updates wanted files and prunes
 * stale marked files, while never touching an unmarked user-authored agent.
 *
 * Claude Code loads the stable executor definitions at session start. A per-ticket
 * dispatch nonce binds the briefing to its authoritative prepared dispatch and
 * rejects stale holders after a re-dispatch.
 *
 * A registered agent file with a `model: <full-id>` frontmatter pin genuinely
 * runs through codex-gateway when spawned with the Agent `model` parameter
 * omitted. Passing an Agent `model` value overrides the pin, so Codex routes
 * advertise `model: null`. Codex routes share TWO executors total
 * (sidequest-exec-dispatch.md and sidequest-exec-dispatch-readonly.md, pinned
 * to the virtual claude-codex-auto): the real model AND effort ride each
 * dispatch briefing as a [sidequest-route model=... effort=...] marker the
 * codex-gateway shim resolves per request (SQ-347/SQ-348), overwriting
 * output_config.effort, so per-effort dispatch defs carried dead frontmatter.
 * The Claude ladder stays per-effort: the Agent tool has no effort parameter,
 * leaving frontmatter as the only carrier. The def set is therefore fixed —
 * route edits never write or register agent files.
 *
 * syncExecAgents() renders through scripts/_exec-template.md via
 * renderExecAgent() below, so the ticket-execution protocol body stays in one
 * place for every generated file.
 *
 * Lifecycle safety: every stable executor file this module writes starts with
 * the generation-two MARKER on its own line. A file WITHOUT either recognized
 * marker — whether or not its name collides with one we'd generate — is NEVER
 * written, overwritten, or deleted; it isn't ours.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require('./exec-names.js');
const crypto = require('crypto');
const store = require('./store.js');
const { worktreeRoot } = require('./worktrees.js');
const { spawnDescription } = store;
const { compileContextProjection, contextRetrieval, contextRevision } = require('./context-packet.js');

type SyncOptions = { dir?: string; readOnlyDeniedTools?: any };
type SyncResult = { written: number; removed: number; unchanged: number };
type FastSyncResult = SyncResult & { skipped: boolean; installHash: string };

const TEMPLATE_PATH = path.join(__dirname, '..', 'scripts', '_exec-template.md');

// Generation two deliberately differs from LEGACY_MARKER before its closing
// delimiter. Pre-1.84 Sidequest only checks for the full legacy marker, so it
// treats gen2 files as user-authored and leaves them alone during version skew.
const LEGACY_MARKER = '<!-- generated-by: sidequest-agentsync -->';
const MARKER = '<!-- generated-by: sidequest-agentsync gen2 -->';
// No generational marker change is needed for temporary definitions: they are
// nonce-named and short-lived, so stale version sessions cannot disrupt the
// stable ladder through this cleanup path.
const TEMP_MARKER = '<!-- generated-by: sidequest-native-agent -->';
const TEMP_PREFIX = 'sidequest-native-';
const TICKET_PREFIX = 'sidequest-ticket-';
const RELOAD_NOTICE = 'Reload plugins before spawning newly created temporary native agents.';
const RESTART_NOTICE = RELOAD_NOTICE;
const ARTIFACT_LIFECYCLE_MARKER = '[sidequest-artifact-mode]';

const NON_MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EXEC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EXECUTOR_CHECKPOINT_TOOL_ROUNDS = 100;
const EXECUTOR_CONTRADICTION_RULE = 'Executor contradiction rule: An anchor is orientation, not a contract. When an anchor names the wrong file, locate the file the work actually needs. If that file is inside declared scope, correct the anchor in your handback and continue. Stop and report a contradiction only when the needed file is outside declared scope or the ticket premise is false. Scope limits writes, never reads: reading any worktree path is allowed. Before reporting, check it and include the checked path or target and result. An existing out-of-scope path or declared output is context, not a contradiction. After evidence of absence, do not redesign the ticket, reject the base, or invent a substitute.';

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

// The virtual model id the codex-gateway shim (>=0.9.0) resolves per request
// from the route marker below. Must match the gateway's advertised id.
const DISPATCH_MODEL_ID = 'claude-codex-auto';
const ROUTE_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROUTE_MARKER_RE = /^\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(low|medium|high|xhigh|max)\]$/;

// The exact marker grammar the shim scans for. Throws rather than emitting a
// marker the gateway would silently ignore (which would 400 the whole run).
function routeMarker(dispatchModel?: any, effort?: any) {
  const model = String(dispatchModel || '');
  const markerEffort = String(effort || '');
  if (!ROUTE_MODEL_RE.test(model)) throw new Error(`dispatch model id is not marker-safe: ${dispatchModel}`);
  if (!EXEC_EFFORTS.includes(markerEffort)) throw new Error(`dispatch effort is not marker-safe: ${effort}`);
  const marker = `[sidequest-route model=${model} effort=${markerEffort}]`;
  if (!ROUTE_MARKER_RE.test(marker)) throw new Error('dispatch route marker does not match the gateway grammar.');
  return marker;
}

function workflowRecipe(category?: any, resolved?: any) {
  const exec = resolved && resolved.exec;
  if (!category || !exec) throw new Error('A resolved category route is required.');

  const recipe: any = {
    project: category.project,
    category: category.id,
    categoryName: category.name,
    backend: exec.backend,
    route: { model: resolved.model, effort: resolved.effort },
    runsLabel: exec.runsLabel,
    agent: null,
    effortCarrier: null,
    warnings: Array.isArray(resolved.warnings) ? resolved.warnings.slice() : [],
  };

  if (exec.backend === 'codex') {
    recipe.agent = {
      model: DISPATCH_MODEL_ID,
      promptPrefix: `${routeMarker(exec.dispatchModel, resolved.effort)}\n\n`,
    };
    recipe.effortCarrier = 'marker';
  } else {
    recipe.agent = { model: exec.model, promptPrefix: '' };
    recipe.effortCarrier = 'none';
  }

  return recipe;
}

// Render one agent file's full source from the shared template. Every runtime
// file is user-scoped rather than plugin-scoped so Claude Code honors its
// permissionMode: bypassPermissions frontmatter. `name` and `effort` are
// required; `modelId`, `marker`, and `extraNote` are optional.
const EXECUTOR_SKILLS = ['playbook:verify-discipline'];

// Never emit a `tools:` line. `default` is a --allowedTools CLI sentinel, not a valid
// agent-frontmatter tool name, so `tools: default, Skill(...)` became an allow-list that
// matched nothing: executors spawned with no Bash and no board MCP tools and could not
// even fetch their briefing. It shipped in 4.40.6 and broke dispatch on every project
// until 4.40.9. The agent listing hid it by rendering the same definition as "All tools",
// so the only proof is a subagent transcript with zero tool calls.
// Skill loading is pinned by `skills:` below; pinning is not restriction, and an executor
// that cannot run a command is strictly worse than one that can load an extra skill.

// Read-only is expressed as a DENY list, not an allow list.
//
// The allow list this replaces enumerated all 54 board tools plus 8 core ones, so it
// restricted nothing on the board side; it cost ~570 tokens of injected frontmatter per
// definition, ten definitions over, purely to leave Edit/Write/NotebookEdit out. It also
// had two failures nobody chose: any tool added later was invisible until someone updated
// the list, and every non-board MCP server was silently excluded — which is why
// visual-evaluation, a read-only category, could not reach Playwright.
//
// This is not a write-proof sandbox and should not be described as one. Bash stays,
// because a reviewer has to be able to run the suite, and Bash can obviously write.
const READ_ONLY_DENIED_TOOLS = [
  'Edit', 'Write', 'NotebookEdit',
  // A read-only ticket reports findings; it does not fan out or publish outward. Both
  // were already excluded by the old allow list, so this keeps behaviour identical.
  'Agent', 'Artifact',
  // Drives the user's real, logged-in browser. Playwright is the isolated one and stays
  // available, per the house rule that UI verification goes through it.
  'mcp__claude-in-chrome',
];

function resolveReadOnlyTools(readOnlyDeniedTools?: any) {
  const extra = Array.isArray(readOnlyDeniedTools) ? readOnlyDeniedTools : [];
  return {
    tools: null,
    disallowedTools: [...new Set([...READ_ONLY_DENIED_TOOLS, ...extra])],
  };
}

function readOnlyNote() {
  return "\n\n**Read-only role:** Do not modify the repository working tree. Bash is for inspection, tests, and verification, not edits. Keep temporary files outside the repository working tree, and do not install packages into the project's package.json or node_modules. If this ticket requires an edit, write a board blocker comment naming the needed change and why, then release the ticket.";
}

function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief, tools, disallowedTools, skills = EXECUTOR_SKILLS }: any) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const toolsLine = Array.isArray(tools) && tools.length ? `tools: ${tools.join(', ')}\n` : '';
  const disallowedToolsLine = Array.isArray(disallowedTools) && disallowedTools.length ? `disallowedTools: ${disallowedTools.join(', ')}\n` : '';
  const skillsLine = Array.isArray(skills) && skills.length ? `skills:\n${skills.map((skill) => `  - ${skill}`).join('\n')}\n` : '';
  return template
    .split('{{NAME}}').join(String(name))
    .split('{{EFFORT}}').join(String(effort))
    .split('{{MODEL_FRONTMATTER}}').join(modelId ? `\nmodel: ${modelId}` : '')
    .split('{{CHECKPOINT_TOOL_ROUNDS}}').join(String(EXECUTOR_CHECKPOINT_TOOL_ROUNDS))
    .split('permissionMode: bypassPermissions').join(`${toolsLine}${disallowedToolsLine}${skillsLine}permissionMode: bypassPermissions`)
    .split('{{MARKER}}').join(marker || '')
    .split('{{EXTRA_NOTE}}').join(extraNote || '')
    .split('{{TICKET_BRIEF}}').join(`Teammate subagent fan-out must omit the Agent \`name\` parameter; named teammate spawns are rejected by the harness.${ticketBrief ? `\n\n${ticketBrief}` : ''}`);
}

// Appended to the two shared dispatch executors' bodies. Model AND effort ride the
// briefing's route marker: the codex-gateway shim resolves both per request and
// overwrites output_config.effort, so this definition's own effort frontmatter is inert
// on this path. The note bans writing marker-shaped text anywhere else (the gateway
// takes the last occurrence in the conversation).
function dispatchNote() {
  return `\n\n_This agent is the shared Sidequest executor for every Codex-backed route at every effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model AND the reasoning effort from the \`[sidequest-route model=... effort=...]\` line in your spawn prompt, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models or efforts: one spawn carries exactly one route marker._`;
}

// The dispatch defs use a safe frontmatter effort for internal non-marker calls.
function collapseEffortProse(body: string): string {
  return body
    .split('Executes one or more sidequest tickets at high reasoning effort.')
    .join('Executes one or more sidequest tickets at the reasoning effort set by the dispatch route marker.')
    .split('running at **high** reasoning effort')
    .join('running at the reasoning effort your dispatch route marker sets');
}

function renderDispatchAgent(_effort?: any) {
  return collapseEffortProse(renderExecAgent({
    name: stableDispatchName(),
    effort: 'high',
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: dispatchNote(),
  }));
}

function renderReadOnlyDispatchAgent(_effort?: any, readOnlyDeniedTools?: any) {
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return collapseEffortProse(renderExecAgent({
    name: stableReadOnlyDispatchName(),
    effort: 'high',
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: `${dispatchNote()}${readOnlyNote()}`,
    tools: readOnlyTools.tools,
    disallowedTools: readOnlyTools.disallowedTools,
  }));
}

function renderReadOnlyClaudeAgent(effort?: any, readOnlyDeniedTools?: any) {
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return renderExecAgent({
    name: stableReadOnlyClaudeName(effort),
    effort,
    marker: MARKER,
    extraNote: readOnlyNote(),
    tools: readOnlyTools.tools,
    disallowedTools: readOnlyTools.disallowedTools,
  });
}

function refToken(ref?: any) {
  return String(ref || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
}

// Turn a resolved runtime (resolveExec's runsModel / slug, e.g.
// "codex-gpt-5-6-luna" or the Claude alias "opus") into a filesystem-safe
// DISPLAY token for the agent name: drop the noisy "codex-" catalog prefix so
// the subagent card reads `gpt-5-6-luna`, and reduce to lowercase [a-z0-9-].
// Returns '' when there's no runtime to show.
function runtimeToken(runtime?: any) {
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
function nativeAgentName(ref?: any, runtime?: any, nonce?: any) {
  const ticket = refToken(ref);
  const token = runtimeToken(runtime);
  const base = token ? `${TEMP_PREFIX}${ticket}-${token}` : `${TEMP_PREFIX}${ticket}`;
  if (nonce == null || nonce === '') return base;
  const suffix = String(nonce).toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(suffix)) throw new Error('native agent nonce must be 6-32 lowercase alphanumeric characters.');
  return `${base}-${suffix}`;
}

function temporaryAgentFile(name?: any, dir?: any) {
  if (!String(name || '').startsWith(TEMP_PREFIX)) {
    throw new Error('temporary agent name must use a Sidequest temporary prefix.');
  }
  return path.join(dir || defaultAgentsDir(), `${name}.md`);
}

function nativeAgentSource(spec?: any) {
  const tools = Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'SendMessage'];
  if (!tools.every((tool: any) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tool)))) throw new Error('native agent tools must be valid tool names.');
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
function waitForNativeAgentReload(waitMs?: any) {
  const ms = Number.isFinite(Number(waitMs)) ? Math.max(0, Number(waitMs)) : 175;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const TICKET_DESCRIPTION_MAX_BYTES = 8 * 1024;
const TICKET_COMMENTS_MAX_BYTES = 6 * 1024;
const TICKET_COMMENT_BODY_MAX_BYTES = 768;
const TICKET_PRIORITY_COMMENT_BODY_MAX_BYTES = 4 * 1024;
const TICKET_COMMENT_PACKET_MARKER_RESERVE_BYTES = 384;
const EXPERIMENT_LOG_PACKET_MAX_BYTES = 12 * 1024;
const STORY_DECISION_LOG_PACKET_MAX_BYTES = 16 * 1024;
const DISPATCH_UNCERTAINTY_PACKET_MAX_BYTES = 1024;
// Section caps keep the serialized spawn under its 2 KB ceiling without letting
// one huge field crowd out the orientation that prevents executor rediscovery.
const DISPATCH_TICKET_CONTEXT_MAX_BYTES = 1200;
const DISPATCH_TITLE_MAX_BYTES = 96;
const DISPATCH_DESCRIPTION_MAX_BYTES = 360;
const DISPATCH_FILES_MAX_BYTES = 180;
const DISPATCH_ANCHORS_MAX_BYTES = 120;
const DISPATCH_STORY_HANDOFF_MAX_BYTES = 320;

function byteLength(value?: any) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function utf8Excerpt(value?: any, maxBytes?: any) {
  const source = String(value || '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (byteLength(source) <= limit) return { text: source, truncated: false };
  let text = '';
  let used = 0;
  for (const character of source) {
    const size = byteLength(character);
    if (used + size > limit) break;
    text += character;
    used += size;
  }
  return { text, truncated: true };
}

function boundedPacket(value?: any, maxBytes?: any, marker?: any) {
  const source = String(value || '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (byteLength(source) <= limit) return source;
  const suffix = String(marker || '');
  return `${utf8Excerpt(source, Math.max(0, limit - byteLength(suffix))).text}${suffix}`;
}

function commentBody(comment?: any) {
  return comment && Object.hasOwn(comment, 'body') ? String(comment.body) : String(comment || '');
}

function isPriorityComment(comment?: any) {
  const kind = String(comment && comment.kind || '');
  const body = commentBody(comment);
  return /\b(?:decision|constraint)\b/i.test(kind)
    || /(?:^|\n)\s*(?:decision|constraint)\s*:/i.test(body);
}

function commentPacketEntry(comment?: any, index?: any, bodyLimit?: any) {
  const body = commentBody(comment);
  const marker = '\n\n[Comment body excerpt truncated. Fetch specifics with compact comments reads.]';
  const excerpt = boundedPacket(body, bodyLimit, marker);
  return [
    `### Comment ${Number(index) + 1}`,
    `Author: ${comment && comment.by ? comment.by : 'unknown'}`,
    `Kind: ${comment && comment.kind ? comment.kind : 'comment'}`,
    `Recorded: ${comment && comment.at ? comment.at : '(timestamp unavailable)'}`,
    'Body:',
    excerpt,
  ].join('\n');
}

function commentPacketMarker(omitted?: any, excerpts?: any, decisionInHistory?: any) {
  const omittedText = omitted ? ` ${omitted} earlier comment(s) were omitted.` : '';
  const excerptText = excerpts ? ` ${excerpts} included comment body excerpt(s) were truncated.` : '';
  const historyText = decisionInHistory
    ? ' A decision or constraint is in omitted history: fetch the full thread.'
    : ' Read the full thread only when this packet flags a decision or constraint in omitted history.';
  return `[Comment packet truncated.${omittedText}${excerptText} Fetch specifics with compact comments reads (latest-first).${historyText}]`;
}

function ticketDescriptionPacket(description?: any) {
  return boundedPacket(
    description || '(No additional description was recorded.)',
    TICKET_DESCRIPTION_MAX_BYTES,
    '\n\n[Description truncated at 8 KB. Fetch ticket specifics before acting.]',
  );
}

function ticketCommentsPacket(comments?: any) {
  if (!Array.isArray(comments) || !comments.length) return '(No ticket comments were recorded.)';
  const complete = comments.map((comment: any, index: number) => commentPacketEntry(comment, index, Number.MAX_SAFE_INTEGER)).join('\n\n');
  if (byteLength(complete) <= TICKET_COMMENTS_MAX_BYTES) return complete;

  const selected: { entry: string; priority: boolean; truncated: boolean }[] = [];
  let bytes = 0;
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    const priority = isPriorityComment(comment);
    const entry = commentPacketEntry(
      comment,
      index,
      priority ? TICKET_PRIORITY_COMMENT_BODY_MAX_BYTES : TICKET_COMMENT_BODY_MAX_BYTES,
    );
    const separatorBytes = selected.length ? byteLength('\n\n') : 0;
    if (bytes + separatorBytes + byteLength(entry) > TICKET_COMMENTS_MAX_BYTES - TICKET_COMMENT_PACKET_MARKER_RESERVE_BYTES) break;
    selected.push({ entry, priority, truncated: entry.includes('[Comment body excerpt truncated.') });
    bytes += separatorBytes + byteLength(entry);
  }

  const omitted = comments.length - selected.length;
  const excerpts = selected.filter((entry) => entry.truncated).length;
  const decisionInHistory = comments.slice(0, omitted).some(isPriorityComment);
  const marker = commentPacketMarker(omitted, excerpts, decisionInHistory);
  const entries = selected.map((entry) => entry.entry).join('\n\n');
  return `${entries}${entries ? '\n\n' : ''}${marker}`;
}

function ticketAssetsPacket(ticket?: any, slug?: any) {
  const assets = Array.isArray(ticket && ticket.assets) ? ticket.assets : [];
  if (!assets.length) return '(No attachments were recorded.)';
  if (!slug) return assets.map((asset: any) => `- WARNING: attachment "${asset}" cannot be resolved because the ticket project is unavailable. Report this blocker before implementation.`).join('\n');
  return assets.map((asset: any) => {
    const absolutePath = path.resolve(store.assetPath(slug, ticket.id, asset));
    try {
      const stat = fs.statSync(absolutePath);
      fs.accessSync(absolutePath, fs.constants.R_OK);
      if (!stat.isFile()) throw new Error('not a file');
      return `- \`${absolutePath}\`\n  Inspect this attachment before implementation.`;
    } catch (_) {
      return `- WARNING: attachment \`${absolutePath}\` is missing or unreadable. Report this blocker before implementation.`;
    }
  }).join('\n');
}

// One line, never the body: a briefing gains only the absolute path (SQ-1015).
// Do not inline the plan content here at any size, and do not add a "small
// plans can be inlined" threshold — that recreates the eager-injection
// problem this replaces and gives authors a size to write to.
function planDocumentPacket(ticket?: any, slug?: any) {
  if (!ticket || !slug) return null;
  const plan = store.ticketPlanInfo(slug, ticket.id || ticket.ref);
  if (!plan) return null;
  const planPath = path.resolve(plan.path);
  return `Plan document: \`${planPath}\` (revision ${plan.revision}, ${plan.by}, ${plan.at}). Read it with \`Read\` and offset/limit on demand; it is never inlined here.`;
}

function experimentCheckoutTarget(ticket?: any) {
  const round = Number(ticket?.dispatch?.launchSeq);
  return Number.isInteger(round) && round > 1
    ? `refs/sidequest/${ticket.ref}/r${round - 1} (continue from the prior round)`
    : 'base (fresh direction)';
}

function experimentLogPacket(ticket?: any, slug?: any) {
  if (!ticket || !slug) return null;
  const experiment = store.experimentPacket(slug, ticket.id || ticket.ref);
  if (!experiment) return null;
  const storedPath = String(experiment.path || '').trim();
  if (!storedPath) return null;
  const logPath = path.resolve(storedPath);
  return boundedPacket([
    `Read the full log at \`${logPath}\` before the first edit.`,
    `Round checkout target: ${experimentCheckoutTarget(ticket)}.`,
    String(experiment.packet || ''),
  ].join('\n\n'), EXPERIMENT_LOG_PACKET_MAX_BYTES, '\n\n[Experiment log packet truncated at 12 KB. Read the full log before the first edit.]');
}

function ticketRouteMarker(ticket?: any) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  return resolved && resolved.backend === 'codex' && resolved.dispatchModel
    ? routeMarker(resolved.dispatchModel, ticket.effort)
    : null;
}

function ticketCloseout(ticket?: any) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const effort = resolved && (resolved.effort || ticket.effort);
  if (!resolved || !effort) return null;
  if (store.sharedTreeArtifactMode(ticket)) {
    const root = ticket.dispatch.artifactRoot;
    const scope = ticket.dispatch.artifactScope;
    return `Closeout: this prepared shared-tree artifact dispatch may write only ${scope} inside approved artifact root ${root}. The shared checkout is the dispatch contract, so do not require a linked worktree. Close with done --model ${resolved.runsModel} --effort ${effort}, include the full final report in its completion comment, and do not commit or submit. Then stop without a routine SendMessage.`;
  }
  if (ticket?.dispatch?.readonly === true) {
    return `Closeout: this prepared dispatch is read-only. Close with done --model ${resolved.runsModel} --effort ${effort} and include the full final report in its completion comment. Do not commit or submit. Then stop without a routine SendMessage.`;
  }
  return `Closeout: this prepared dispatch is write-capable. Commit scoped repo changes, then submit with the commit hash, verification evidence, and final report. For non-repo output, close with done --model ${resolved.runsModel} --effort ${effort}. After submit, keep the terminal board comment to the commit hash, verify evidence, and a reference to the submission instead of repeating its narrative. Non-repo done comments still carry the full report. Then stop without a routine SendMessage.`;
}

function ticketContinuationPacket(ticket?: any) {
  const continuation = ticket?.dispatch?.continuation;
  if (continuation?.mode === 'checkpoint_replay' && Array.isArray(continuation.commits) && continuation.commits.length) {
    const branch = continuation.sourceBranch || '(detached HEAD)';
    return [
      'Continuation handoff:',
      `The previous executor released this same ticket from worktree ${continuation.sourceWorktree}.`,
      `Previous branch: ${branch}`,
      `Checkpoint commit: ${continuation.commit}`,
      'Claude Code Agent spawns cannot attach a new agent to an existing linked worktree, so this dispatch carries the released commit range into its fresh isolated worktree.',
      `After claiming and before any other work, run \`git cherry-pick ${continuation.commits.join(' ')}\`.`,
      'If the cherry-pick fails, stop and report the failure. Do not rediscover or rewrite the checkpointed work.',
    ].join('\n');
  }
  const fallback = ticket?.dispatch?.continuationFallback;
  if (!fallback?.reason) return null;
  return `Continuation fallback: the previous released worktree was not carried (${String(fallback.reason).replace(/_/g, ' ')}). This dispatch uses a fresh worktree. ${fallback.sourceWorktree ? `Previous worktree: ${fallback.sourceWorktree}.` : ''}`.trim();
}

function ticketWorktreeSync(ticket?: any, projectPath?: any) {
  const dispatch = ticket?.dispatch;
  const root = String(projectPath || '').trim();
  const target = dispatch?.integrationTarget;
  const commit = String(dispatch?.baseCommit || '').trim();
  if (dispatch?.sharedTree !== false || !root || !target || !commit) return null;
  const branch = String(target.mode === 'remote' ? `refs/remotes/origin/${target.branch}` : target.branch || '').trim();
  if (!branch) return null;
  return [
    `Worktree synchronization (run before work): check \`git merge-base --is-ancestor ${commit} HEAD\`.`,
    `If it fails, run \`git fetch ${quotedShellArgument(root)} ${quotedShellArgument(branch)}\` then \`git reset --hard ${commit}\`.`,
    `After a successful reset, post one board comment: \`[sidequest:worktree-sync] synced to ${commit}\`.`,
    'If fetching or resetting fails, stop and report the failure instead of working from the stale base.',
  ].join(' ');
}

function storyContractPacket(ticket?: any, slug?: any) {
  const snapshot = ticket && ticket.dispatch && ticket.dispatch.storyContract
    ? ticket.dispatch.storyContract
    : store.storyExecutionContract(ticket && ticket.storyId ? store.getStory(slug, ticket.storyId) : null);
  if (!snapshot || !snapshot.body) return null;
  return `## Story execution contract (revision ${Number(snapshot.revision) || 1})\n${snapshot.body}`;
}

function storyDecisionLogPacket(ticket?: any, slug?: any) {
  const story = ticket && ticket.storyId && slug ? store.getStory(slug, ticket.storyId) : null;
  const entries = Array.isArray(story && story.decisionLog)
    ? story.decisionLog.slice().sort((left: any, right: any) => Number(left.seq) - Number(right.seq))
    : [];
  if (!entries.length) return null;
  const revision = Number(story.logRevision) || Number(entries[entries.length - 1].seq) || 0;
  const render = (selected: any[], omitted: number) => {
    const marker = omitted
      ? `\n\n[Story decision log briefing window omitted ${omitted} earlier ${omitted === 1 ? 'entry' : 'entries'}. Read the full history with sidequest story log ${story.ref} --full before acting.]`
      : '';
    return [
      `## Story decision log (${story.ref}, ${selected.length} ${omitted ? 'recent ' : ''}${selected.length === 1 ? 'entry' : 'entries'} through #${revision})`,
      'Findings appended by sibling executors on this story. The contract above outranks these.',
      ...selected.map((entry: any) => `- #${entry.seq} ${entry.kind} (${entry.ref || 'orchestrator'}, ${entry.by}): ${entry.text}`),
    ].join('\n') + marker;
  };
  const selected: any[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = [entries[index], ...selected];
    if (byteLength(render(candidate, entries.length - candidate.length)) > STORY_DECISION_LOG_PACKET_MAX_BYTES) break;
    selected.unshift(entries[index]);
  }
  return render(selected, entries.length - selected.length);
}

function storyDecisionLogSpawnPacket(ticket?: any, slug?: any) {
  const story = ticket && ticket.storyId && slug ? store.getStory(slug, ticket.storyId) : null;
  const entries = Array.isArray(story && story.decisionLog)
    ? story.decisionLog.slice().sort((left: any, right: any) => Number(right.seq) - Number(left.seq))
    : [];
  if (!entries.length) return null;
  const revision = Number(story.logRevision) || Number(entries[0].seq) || 0;
  return boundedPacket([
    `Story handoff (${story.ref}, newest first through #${revision}):`,
    ...entries.map((entry: any) => `- #${entry.seq} ${entry.kind} (${entry.ref || 'orchestrator'}, ${entry.by}): ${entry.text}`),
  ].join('\n'), DISPATCH_STORY_HANDOFF_MAX_BYTES, '\n[Story handoff excerpt capped. Full newest-first window is in briefing.]');
}

function ticketContractsPacket(ticket?: any) {
  const contracts = store.normalizeContracts(ticket && ticket.contracts);
  const entries = [
    ...contracts.produces.map((name?: any) => `- produces: ${name}`),
    ...contracts.changes.map((name?: any) => `- changes: ${name}`),
    ...contracts.consumes.map((name?: any) => `- consumes: ${name}`),
  ];
  if (ticket && ticket.contractWaiver) entries.push('- reviewed waiver: true');
  return entries.length ? entries.join('\n') : '(No contract metadata was recorded.)';
}

function ticketReadinessContractPacket(ticket?: any, slug?: any) {
  if (!ticket || !slug) return '(No contract-edge sequencing applies.)';
  const dependencies = store.readyWaveDependencies(slug).filter((edge?: any) => edge.before === ticket.ref || edge.after === ticket.ref);
  return dependencies.length
    ? dependencies.map((edge?: any) => `- ${edge.reason}`).join('\n')
    : '(No contract-edge sequencing applies.)';
}

function findingCheckpointPacket(ticket?: any) {
  const category = ticket?.category || {};
  const categoryText = [ticket?.categoryId, category.id, category.name].filter(Boolean).join(' ');
  const readOnly = ticket?.dispatch?.readonly === true;
  const analysis = /\b(?:analysis|research|investigation)\b/i.test(categoryText);
  if (!readOnly && !analysis) return null;
  const durableArtifact = readOnly
    ? 'This is a read-only dispatch, so board comments are its only durable artifact.'
    : 'This is analysis, research, or investigation work.';
  return `${durableArtifact} Post each substantive intermediate finding as a ticket comment when it lands, including after a theory pass, a measurement, or a reproduction. Record findings only, not a progress diary. If the run dies, it should lose at most the current step, not the whole investigation.`;
}

// An executor cannot tell an isolated tree from the shared checkout by looking
// at its file paths, and the one place that knows the dispatch asked for
// isolation is this packet. Resume is the trap: the harness discards an
// unchanged worktree when its agent stops, so an executor that pauses for a
// scope request before its first edit comes back in the shared checkout with no
// warning (SQ-825, 2026-07-24).
function ticketWorktreeIdentity(ticket?: any, projectPath?: any) {
  const dispatch = ticket?.dispatch;
  const root = String(projectPath || '').trim();
  if (!dispatch || !root || dispatch.sharedTree == null) return null;
  const sharedTree = dispatch.sharedTree === true;
  const worktree = sharedTree ? root : String(dispatch.worktree || '').trim();
  if (!worktree) return null;
  const gitDir = sharedTree
    ? path.join(root, '.git')
    : path.join(root, '.git', 'worktrees', path.basename(worktree));
  const identity = `Worktree identity: ${sharedTree ? 'shared tree' : 'linked worktree'}\nPath: ${worktree}\nGit dir: ${gitDir}`;
  if (!sharedTree) return identity;
  return [
    identity,
    `Working directory binding: your inherited shell cwd is wherever the spawning session ran and may be a stale linked worktree outside ${root}.`,
    `Before any git or file operation, \`cd "${root}"\` and confirm \`git rev-parse --show-toplevel\` prints \`${root}\`.`,
    'If it still differs after cd, stop and report to the orchestrator. Do not release or write anything in the wrong tree.',
  ].join('\n');
}

function ticketReadOnlyScratchSpace(ticket?: any) {
  if (ticket?.dispatch?.readonly !== true) return null;
  return ticket.dispatch.sharedTree === true
    ? 'Read-only shared checkout: keep temporary files in the session scratchpad, never the repository working tree. The scratchpad is shared, so it is not a durable ticket artifact.'
    : 'Read-only linked worktree: keep temporary files in your own worktree, not the shared session scratchpad.';
}

function ticketIsolationContract(ticket?: any, projectPath?: any) {
  if (!ticket || !ticket.dispatch || ticket.dispatch.sharedTree !== false) return null;
  const root = String(projectPath || '').trim() || '<board project path>';
  const dispatch = ticket.dispatch;
  const expected = String(dispatch.worktree || '').trim() || path.join(worktreeRoot(root), 'agent-<your agent id>');
  return [[
    'Worktree isolation contract: this dispatch runs in its own linked worktree, never in the shared checkout.',
    `Expected worktree root: ${expected}`,
    'Confirm it before your first write, and again after any resume from a coordinator message: `git rev-parse --git-dir` must differ from `git rev-parse --git-common-dir`.',
    `If they match you are in the shared checkout ${root}. Stop. Write nothing, tell the orchestrator this ticket lost its worktree and needs re-dispatch, and name any work you already have staged there so it can be committed out of the shared tree rather than lost.`,
  ].join('\n')];
}

// The dependent-consumption half of SQ-1015: a blocks/blocked-by edge is the
// whole point of planning (the linked ticket's plan is upstream context), and
// it was previously 0% delivered — a link rendered as a bare ref with nothing
// else. `related` links are excluded; they carry no ordering relationship.
const DEPENDENCY_LINK_TYPES = new Set(['blocks', 'blocked-by']);

function linkedPlanSuffix(link?: any, slug?: any) {
  if (!slug || !link || !DEPENDENCY_LINK_TYPES.has(String(link.type))) return '';
  const plan = link.ref ? store.ticketPlanInfo(slug, link.ref) : null;
  return plan ? ` (plan: ${path.resolve(plan.path)})` : '';
}

function capturedVerifyCommand(verify?: any) {
  const command = String(verify || '').trim();
  if (!command) return '';
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  const captureScript = path.join(__dirname, 'verify-capture.js');
  return `node "${captureScript}" --base64 ${encoded}`;
}

function dispatchUncertaintyPacket(ticket?: any, slug?: any) {
  const warnings = store.dispatchUncertaintyWarnings(ticket, slug);
  if (!warnings.length) return null;
  return boundedPacket(
    `Flagged uncertainty:\n${warnings.map((warning: any) => `- ${warning}`).join('\n')}`,
    DISPATCH_UNCERTAINTY_PACKET_MAX_BYTES,
    '\n[Additional dispatch uncertainty warnings truncated.]',
  );
}

const EXECUTOR_BRIEFING_MAX_BYTES = 24 * 1024;
const EXECUTOR_CONTRACT_MAX_BYTES = 12 * 1024;

function sha256Text(value?: any) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function projectionRetrieval(tool?: any, argumentsValue?: any) {
  return { tool: String(tool), arguments: argumentsValue || {} };
}

function projectionCall(retrieval?: any) {
  return `${retrieval.tool}(${JSON.stringify(retrieval.arguments)})`;
}

function briefingProjectArguments(project?: any) {
  return project ? { project } : {};
}

function storySnapshot(ticket?: any, slug?: any) {
  const dispatch = ticket?.dispatch;
  const hasFrozenSnapshot = !!dispatch && Object.prototype.hasOwnProperty.call(dispatch, 'storyContract');
  const snapshot = hasFrozenSnapshot
    ? dispatch.storyContract
    : store.storyExecutionContract(ticket?.storyId ? store.getStory(slug, ticket.storyId) : null);
  const story = ticket?.storyId && slug ? store.getStory(slug, ticket.storyId) : null;
  return {
    body: String(snapshot?.body || ''),
    revision: Number(snapshot?.revision) || 1,
    story: String(story?.ref || ticket?.storyId || ''),
    frozenAbsent: hasFrozenSnapshot && snapshot == null,
  };
}

function storyContractRetrieval(ticket?: any, snapshot?: any, project?: any, forceHandle = false) {
  const body = String(snapshot?.body || '');
  if (!forceHandle && !snapshot?.frozenAbsent && byteLength(body) <= EXECUTOR_CONTRACT_MAX_BYTES) {
    return projectionRetrieval('mcp__plugin_sidequest_board__story_contract', Object.assign(
      briefingProjectArguments(project),
      { story: snapshot.story, cursor: 0, limit: 16384, full: true },
    ));
  }
  const hash = sha256Text(body);
  return projectionRetrieval('mcp__plugin_sidequest_board__' + 'context_page', contextRetrieval({
    tool: 'dispatch',
    project: String(project || ticket?.project || 'unbound'),
    kind: 'body',
    field: 'dispatch.storyContract',
    position: 'storyContract',
    revision: contextRevision(body),
    reason: 'frozen-snapshot',
    selector: {
      ref: String(ticket?.ref || ''),
      snapshotRevision: Number(snapshot?.revision) || 1,
      sha256: hash,
      totalBytes: byteLength(body),
      ...(snapshot?.frozenAbsent ? { frozenAbsent: true } : {}),
    },
  }).arguments);
}

function storyContractProjectionBody(snapshot?: any, retrieval?: any, forceHandle = false) {
  if (snapshot.frozenAbsent) return '## Story execution contract\nFrozen dispatch snapshot contains no contract.';
  const totalBytes = byteLength(snapshot.body);
  const hash = sha256Text(snapshot.body);
  const metadata = `snapshot revision ${snapshot.revision}; sha256 ${hash}; totalBytes ${totalBytes}`;
  if (forceHandle || totalBytes > EXECUTOR_CONTRACT_MAX_BYTES) {
    return [
      `## Story execution contract (revision ${snapshot.revision}; ${metadata})`,
      'Required before editing: fetch the paged snapshot with ' + projectionCall(retrieval) + '. Continue with its nextCursor until complete; do not replace this frozen snapshot with a live contract.',
    ].join('\n');
  }
  return `## Story execution contract (revision ${snapshot.revision})\nSnapshot ${metadata}.\n${snapshot.body}`;
}

function storyDecisionProjectionBody(ticket?: any, slug?: any) {
  const story = ticket?.storyId && slug ? store.getStory(slug, ticket.storyId) : null;
  const entries = Array.isArray(story?.decisionLog)
    ? story.decisionLog.slice().sort((left: any, right: any) => Number(left.seq) - Number(right.seq))
    : [];
  if (!entries.length) return '(No live story decisions or constraints were recorded.)';
  const revision = Number(story?.logRevision) || Number(entries[entries.length - 1].seq) || 0;
  const render = (selected: any[], omitted: number) => {
    const marker = omitted
      ? `\n\n[Story decision log briefing window omitted ${omitted} earlier ${omitted === 1 ? 'entry' : 'entries'}. Read the full history with sidequest story log ${story.ref} --full before acting.]`
      : '';
    return [
      `## Story decision log (${String(story?.ref || ticket?.storyId || '(unknown story)')}, ${selected.length} ${omitted ? 'recent ' : ''}${selected.length === 1 ? 'entry' : 'entries'} through #${revision})`,
      'Live watermark: this log is current at briefing time and is not part of the frozen contract snapshot.',
      ...selected.map((entry: any) => `- #${entry.seq} ${entry.kind} (${entry.ref || 'orchestrator'}, ${entry.by}): ${entry.text}`),
    ].join('\n') + marker;
  };
  const selected: any[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = [entries[index], ...selected];
    if (byteLength(render(candidate, entries.length - candidate.length)) > STORY_DECISION_LOG_PACKET_MAX_BYTES) break;
    selected.unshift(entries[index]);
  }
  return render(selected, entries.length - selected.length);
}

function briefingCommentBody(comments?: any) {
  const entries = Array.isArray(comments) ? comments.slice().reverse() : [];
  if (!entries.length) return '(No ticket comments were recorded.)';
  return [
    '## Newest ticket evidence and comments (newest first)',
    ...entries.map((comment: any, index: number) => [
      `### Comment ${entries.length - index}`,
      `Author: ${comment.by || 'unknown'}`,
      `Kind: ${comment.kind || 'comment'}`,
      `Recorded: ${comment.at || '(timestamp unavailable)'}`,
      'Body:',
      commentBody(comment),
    ].join('\n')),
  ].join('\n\n');
}

function executorSafetyBody(ticket?: any, nonce?: any, project?: any, executor?: any, closeout?: any, worktreeIdentity?: any, readOnlyScratchSpace?: any, worktreeSync?: any) {
  const claimCall = [
    'mcp__plugin_sidequest_board__claim({',
    `  ref: ${JSON.stringify(ticket.ref)},`,
    '  by: "<choose a unique id>",',
    `  executor: ${JSON.stringify(executor)},`,
    `  effort: ${JSON.stringify(ticket.effort)},`,
    `  project: ${JSON.stringify(project)},`,
    `  token: ${JSON.stringify(nonce)}`,
    '})',
  ].join('\n');
  const verify = ticket.executorVerifyKind === 'attestation'
    ? `Verify oracle: attestation. Record actual evidence for ${ticket.executorAttestationArtifact}.`
    : `Verify command: ${ticket.executorVerify || '(No exact verify command was recorded.)'}`;
  const highStakes = ticket?.highStakes
    ? [
      'High-stakes verification:',
      'Enumerate and check EVERY consumer of each changed surface. Run every affected consumer suite, including dashboard build/tests when board payloads change. A review-audit pass is mandatory before integration.',
    ]
    : [];
  return [
    '## Dispatch, claim, worktree, lifecycle, and verification safety',
    'Claim first with this exact call. Do not pass direct or replace the prepared executor:',
    ['```javascript', claimCall, '```'].join('\n'),
    ...(worktreeIdentity ? [worktreeIdentity] : []),
    ...(readOnlyScratchSpace ? [readOnlyScratchSpace] : []),
    ...(worktreeSync ? [worktreeSync] : []),
    ...(ticketIsolationContract(ticket, project) || []),
    verify,
    ticket.executorVerify && ticket.executorVerifyKind !== 'attestation'
      ? 'Run it through ' + capturedVerifyCommand(ticket.executorVerify) + '; post [sidequest:verify-start] before it and [sidequest:verify-complete] with status first after it exits.'
      : '',
    ...(highStakes.length ? [highStakes.join('\n')] : []),
    closeout || '',
    'Stay within declared scope. If required context is omitted below, fetch it once with its listed retrieval call before editing. Do not guess or silently skip it.',
  ].filter(Boolean).join('\n\n');
}

function executorTaskBody(ticket?: any, category?: any, declaredFiles?: any, uncertainty?: any, planDocument?: any, experimentLog?: any, findingCheckpoints?: any, continuation?: any) {
  return [
    '## This ticket',
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || '(Untitled ticket)'}`,
    `Description:
${ticket.description || '(No additional description was recorded.)'}`,
    `Category contract:
Category: ${category.id || ticket.categoryId || '(Unclassified)'}
Configured route: ${category.route?.model || '(No configured route)'} / ${category.route?.effort || '(No configured effort)'}
Dispatch route: ${ticket.model || category.route?.model || '(No route)'} / ${ticket.effort || category.route?.effort || '(No effort)'}
${category.contract || '(No category-specific executor instructions were recorded.)'}`,
    ...(uncertainty ? [uncertainty] : []),
    EXECUTOR_CONTRADICTION_RULE,
    ...(findingCheckpoints ? [`Durable finding checkpoints:\n${findingCheckpoints}`] : []),
    ...(continuation ? [continuation] : []),
    ...(experimentLog ? [`Experiment log:\n${experimentLog}`] : []),
    `Declared files:\n${declaredFiles}`,
    ...(planDocument ? [planDocument] : []),
    'Scope check: request scope when a needed path is outside the declared set. The answer is immediate. On refusal, commit in-scope work and release with kind `handback`, naming the refused paths. The orchestrator can expand the ticket files and redispatch. A declared directory covers descendants. On the first uncovered scope miss, sweep tests, fixtures, goldens, and generated outputs, then make one consolidated request. Never ship a compensating or downstream workaround inside scope instead: a verified workaround is not a substitute for the root fix.',
  ].join('\n\n');
}

function taskAndScopeBody(ticket?: any, slug?: any) {
  const category = ticket?.category || {};
  const declared = Array.isArray(ticket?.files) ? ticket.files : [];
  const declaredFiles = declared.length ? declared.map((file: any) => `- ${file}`).join('\n') : '(No files were declared.)';
  const effectiveFiles = store.effectiveScope(slug, declared);
  const declaredKeys = new Set(declared.map((file: any) => process.platform === 'win32' ? String(file).toLowerCase() : String(file)));
  const alwaysKeys = new Set((store.boardConfig(slug)?.alwaysInScope || []).map((file: any) => process.platform === 'win32' ? String(file).toLowerCase() : String(file)));
  const generatedFiles = effectiveFiles.filter((file: any) => {
    const key = process.platform === 'win32' ? String(file).toLowerCase() : String(file);
    return !declaredKeys.has(key) && !alwaysKeys.has(key);
  });
  const scopedFiles = generatedFiles.length
    ? `${declaredFiles}\n\nAuto-paired tracked generated files (regenerate before verifying):\n${generatedFiles.map((file: any) => `- ${file}`).join('\n')}`
    : declaredFiles;
  return executorTaskBody(ticket, category, scopedFiles, dispatchUncertaintyPacket(ticket, slug), planDocumentPacket(ticket, slug), experimentLogPacket(ticket, slug), findingCheckpointPacket(ticket), ticketContinuationPacket(ticket));
}

function taskAndScopeRetrieval(ticket?: any, slug?: any) {
  const body = taskAndScopeBody(ticket, slug);
  return projectionRetrieval('mcp__plugin_sidequest_board__' + 'context_page', contextRetrieval({
    tool: 'briefing', project: String(slug || ticket?.project || 'unbound'), kind: 'body', field: 'task-and-scope', position: 'task-and-scope', revision: contextRevision(body), reason: 'budget', selector: { ref: String(ticket?.ref || '') },
  }).arguments);
}

function executorHandlesBody(ticket?: any, slug?: any) {
  const links = Array.isArray(ticket.links) && ticket.links.length
    ? ticket.links.map((link: any) => `- ${link.type || 'related'}: ${link.ref || '(unknown ticket)'}${linkedPlanSuffix(link, slug)}`).join('\n')
    : '(No ticket dependencies were recorded.)';
  return [
    '## Context handles and summaries',
    `Contract metadata:
${ticketContractsPacket(ticket)}`,
    `Readiness contract edges:
${ticketReadinessContractPacket(ticket, slug)}`,
    `Dependencies:
${links}`,
    `Attachments (inspect every readable attachment before implementation):
${ticketAssetsPacket(ticket, slug)}`,
  ].join('\n\n');
}

function renderExecutorProjection(packet?: any) {
  const items = packet.items.map((item: any) => item.body).filter(Boolean);
  const omissions = packet.omissions.length
    ? [
      '## Omitted context',
      ...packet.omissions.map((item: any) => {
        const required = item.id === 'execution-contract' ? ' Required before editing.' : '';
        return '- ' + item.id + ' ' + item.reason + ' (originalBytes ' + item.originalBytes + '). Retrieve with ' + projectionCall(item.retrieval) + '.' + required;
      }),
    ].join('\n')
    : '';
  return [
    '## Executor ContextProjection v1',
    `Aggregate budget: ${EXECUTOR_BRIEFING_MAX_BYTES} bytes. Projection revision: ${packet.revision}. Projection hash: ${packet.hash}. Serialized bytes: ${packet.serializedBytes}.`,
    `Watermarks: ${Object.entries(packet.watermarks).map(([key, value]) => `${key}=${value}`).join(', ') || '(none)'}.`,
    ...items,
    ...(omissions ? [omissions] : []),
  ].join('\n\n');
}

function ticketBrief(ticket?: any, nonce?: any, marker?: any, slug?: any, projectPath?: any) {
  const category = ticket.category || {};
  const project = String(projectPath || (slug && store.readMeta(slug)?.path) || '').trim();
  const executor = String(ticket.dispatchExecutor || ticket.exec?.agent || '').trim();
  const declared = Array.isArray(ticket.files) ? ticket.files : [];
  const declaredFiles = declared.length ? declared.map((file: any) => `- ${file}`).join('\n') : '(No files were declared.)';
  const effectiveFiles = store.effectiveScope(slug, declared);
  const declaredKeys = new Set(declared.map((file: any) => process.platform === 'win32' ? String(file).toLowerCase() : String(file)));
  const alwaysKeys = new Set((store.boardConfig(slug)?.alwaysInScope || []).map((file: any) => process.platform === 'win32' ? String(file).toLowerCase() : String(file)));
  const generatedFiles = effectiveFiles.filter((file: any) => {
    const key = process.platform === 'win32' ? String(file).toLowerCase() : String(file);
    return !declaredKeys.has(key) && !alwaysKeys.has(key);
  });
  const scopedFiles = generatedFiles.length
    ? `${declaredFiles}\n\nAuto-paired tracked generated files (regenerate before verifying):\n${generatedFiles.map((file: any) => `- ${file}`).join('\n')}`
    : declaredFiles;
  const closeout = ticketCloseout(ticket);
  const worktreeSync = ticketWorktreeSync(ticket, project);
  const worktreeIdentity = ticketWorktreeIdentity(ticket, project);
  const readOnlyScratchSpace = ticketReadOnlyScratchSpace(ticket);
  const uncertainty = dispatchUncertaintyPacket(ticket, slug);
  const planDocument = planDocumentPacket(ticket, slug);
  const experimentLog = experimentLogPacket(ticket, slug);
  const findingCheckpoints = findingCheckpointPacket(ticket);
  const continuation = ticketContinuationPacket(ticket);
  const taskAndScope = taskAndScopeBody(ticket, slug);
  const taskRetrieval = taskAndScopeRetrieval(ticket, slug);
  const snapshot = storySnapshot(ticket, slug);
  const commentsRetrieval = projectionRetrieval('mcp__plugin_sidequest_board__comments', Object.assign(briefingProjectArguments(project), { ref: ticket.ref }));
  const storyLogRetrieval = projectionRetrieval('mcp__plugin_sidequest_board__story_log', Object.assign(briefingProjectArguments(project), { story: snapshot.story }));
  const ticketRetrieval = projectionRetrieval('mcp__plugin_sidequest_board__comments', Object.assign(briefingProjectArguments(project), { ref: ticket.ref }));
  const suffix = marker ? `

${marker}` : '';
  const artifactSafety = store.sharedTreeArtifactMode(ticket)
    ? `\n\nArtifact lifecycle exception:\n${ARTIFACT_LIFECYCLE_MARKER}\nThis dispatch deliberately runs in the shared checkout. Write only within the declared artifact scope. Do not apply the linked-worktree self-check, commit, or submit. Close with done after verification.`
    : '';
  const profileBudget = EXECUTOR_BRIEFING_MAX_BYTES - byteLength(suffix);
  const buildItems = (forceContractHandle = false) => {
    const contractRetrieval = storyContractRetrieval(ticket, snapshot, slug || project, forceContractHandle);
    return [
    { id: 'safety', kind: 'safety', priority: 600, order: 1, body: executorSafetyBody(ticket, nonce, project, executor, closeout, worktreeIdentity, readOnlyScratchSpace, worktreeSync) + artifactSafety, retrieval: ticketRetrieval },
    { id: 'execution-contract', kind: 'contract', priority: 500, order: 2, watermark: `${snapshot.revision}:${sha256Text(snapshot.body)}`, body: storyContractProjectionBody(snapshot, contractRetrieval, forceContractHandle), retrieval: contractRetrieval },
    { id: 'live-story-log', kind: 'risk', priority: 400, order: 3, watermark: String((ticket?.storyId && slug ? store.getStory(slug, ticket.storyId)?.logRevision : 0) || 0), body: storyDecisionProjectionBody(ticket, slug), retrieval: storyLogRetrieval },
    { id: 'task-and-scope', kind: 'task', priority: 300, order: 4, body: taskAndScope, retrieval: taskRetrieval },
    { id: 'newest-comments', kind: 'evidence', priority: 200, order: 5, body: briefingCommentBody(ticket.comments), retrieval: commentsRetrieval },
    { id: 'handles', kind: 'handle', priority: 100, order: 6, body: executorHandlesBody(ticket, slug), retrieval: ticketRetrieval },
    ];
  };
  const watermarks = {
    storyContractSnapshot: `${snapshot.revision}:${sha256Text(snapshot.body)}`,
    storyDecisionLog: String((ticket?.storyId && slug ? store.getStory(slug, ticket.storyId)?.logRevision : 0) || 0),
  };
  const compile = (forceContractHandle = false) => compileContextProjection({
    profile: { id: 'executor-briefing', budgetBytes: profileBudget },
    revision: Number(ticket?.dispatch?.launchSeq) || 1,
    watermarks,
    items: buildItems(forceContractHandle),
  });
  let packet = compile();
  const contract = packet.items.find((item: any) => item.id === 'execution-contract');
  if (!contract || contract.truncated || packet.omissions.some((item: any) => item.id === 'execution-contract')) packet = compile(true);
  const rendered = renderExecutorProjection(packet);
  const result = `${rendered}${suffix}`;
  if (byteLength(result) > EXECUTOR_BRIEFING_MAX_BYTES) {
    throw new RangeError(`executor ContextProjection exceeded its ${EXECUTOR_BRIEFING_MAX_BYTES}-byte aggregate budget`);
  }
  return result;
}

// The launch prompt carries bounded implementation orientation. The token-gated
// fetch keeps comments, attachments, claim details, and lifecycle instructions
// out of the orchestrator transcript until the executor needs them.
function renderTicketBriefing(ticket?: any, nonce?: any, slug?: any, projectPath?: any) {
  if (typeof nonce !== 'string' || !nonce.trim() || /[\r\n]/.test(nonce)) {
    throw new Error('dispatch briefing nonce is required and must be a non-empty one-line string.');
  }
  return ticketBrief(ticket, nonce.trim(), ticketRouteMarker(ticket), slug, projectPath);
}

function ticketIsolation(ticket?: any, sharedTree?: any) {
  return sharedTree === true ? null : 'worktree';
}

function withProjectIdentity(prompt?: any, projectPath?: any) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Agent spawn prompt is required.');
  const project = String(projectPath || '').trim();
  if (!project) return text;
  return `${text}\n\nDispatch board identity: --project "${project.replace(/"/g, '\\"')}"`;
}

function quotedShellArgument(value?: any) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function dispatchLauncherPath() {
  return path.join(store.homeRoot(), 'sidequest-launcher.js');
}

function dispatchLauncherSource() {
  return `'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compareVersions(left, right) {
  const parts = (value) => String(value || '').split(/[^0-9]+/).map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function currentSidequestCli() {
  const claudeHome = process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const installs = registry.plugins?.['sidequest@eigenwise-toolshed'] || [];
  const candidates = installs
    .filter((install) => install?.installPath)
    .map((install) => ({ ...install, script: path.join(install.installPath, 'bin', 'sidequest.js') }))
    .filter((install) => fs.existsSync(install.script));
  candidates.sort((left, right) => compareVersions(right.version, left.version)
    || String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')));
  return candidates[0]?.script;
}

const script = currentSidequestCli();
if (!script) throw new Error("Sidequest is not installed in Claude Code's plugin registry.");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`;
}

function ensureDispatchLauncher() {
  const filePath = dispatchLauncherPath();
  const source = dispatchLauncherSource();
  let current = null;
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (current !== source) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o600 });
  }
  return filePath;
}

function dispatchTicketContext(ticket?: any, projectPath?: any) {
  const title = boundedPacket(
    ticket?.title || '(Untitled ticket)',
    DISPATCH_TITLE_MAX_BYTES,
    '[Title excerpt capped.]',
  );
  const description = boundedPacket(
    ticket?.description || '(No additional description was recorded.)',
    DISPATCH_DESCRIPTION_MAX_BYTES,
    '\n[Description excerpt capped. Full body is in briefing.]',
  );
  const declaredFiles = boundedPacket(
    Array.isArray(ticket?.files) && ticket.files.length
      ? ticket.files.map((file: any) => `- ${file}`).join('\n')
      : '(No files were declared.)',
    DISPATCH_FILES_MAX_BYTES,
    '\n[Declared files excerpt capped. Full scope is in briefing.]',
  );
  const anchors = boundedPacket(
    ticket?.executorAnchors || '(No anchors were recorded.)',
    DISPATCH_ANCHORS_MAX_BYTES,
    '\n[Anchors excerpt capped. Full anchors are in briefing.]',
  );
  let slug = null;
  if (ticket?.storyId) {
    try { slug = store.findProject(projectPath)?.slug || null; } catch (_) {}
  }
  const storyHandoff = storyDecisionLogSpawnPacket(ticket, slug);
  return boundedPacket([
    `Title: ${title}`,
    `Description:\n${description}`,
    `Declared files:\n${declaredFiles}`,
    `Anchors:\n${anchors}`,
    ...(storyHandoff ? [storyHandoff] : []),
  ].join('\n\n'), DISPATCH_TICKET_CONTEXT_MAX_BYTES, '\n\n[Spawn orientation capped. Full implementation context is in briefing.]');
}

function renderDispatchStub(ticket?: any, nonce?: any, projectPath?: any) {
  const project = String(projectPath || '').trim();
  if (!project) throw new Error('Dispatch board project path is required.');
  const marker = ticketRouteMarker(ticket);
  const command = [
    'node',
    quotedShellArgument(ensureDispatchLauncher()),
    'briefing',
    String(ticket.ref),
    '--token',
    String(nonce).trim(),
    '--project',
    quotedShellArgument(project),
  ].join(' ');
  return [
    ...(marker ? [marker, ''] : []),
    'Implementation context:',
    dispatchTicketContext(ticket, project),
    '',
    'Fetch the token-gated briefing for comments, attachments, claim, verification, and lifecycle details.',
    `FIRST action: run \`${command}\` and execute exactly what it prints.`,
  ].join('\n');
}

function agentSpawn(name?: any, isolation?: any, model?: any, agentType?: any, prompt?: any, description?: any) {
  return Object.assign({ subagent_type: agentType || name, name, mode: 'bypassPermissions' },
    description !== undefined ? { description } : {}, isolation ? { isolation } : {}, model ? { model } : {}, prompt ? { prompt } : {});
}

function createNativeAgent(spec?: any, opts?: any) {
  opts = opts || {};
  spec = spec || {};
  // The stable route remains the default until orchestration deliberately opts
  // into a ticket-specific definition. It stays available while the watcher is
  // registering a new temporary definition.
  if (spec.agentType) {
    const runtime = spec.runtime != null ? spec.runtime : spec.runsModel;
    // No definition file is written on this route, so the name is free to be the
    // readable launch name instead of the file-safe temporary one.
    const name = spec.launchName ? String(spec.launchName) : nativeAgentName(spec.ref, runtime, spec.nonce);
    const model = spec.spawnModel == null ? null : String(spec.spawnModel).trim();
    return {
      name,
      file: null,
      fallback: true,
      spawn: agentSpawn(name, spec.isolation, model, String(spec.agentType), spec.prompt, spec.description),
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
    } catch (err: any) {
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
    spawn: agentSpawn(name, spec.isolation, spec.spawnModel, undefined, spec.prompt, spec.description),
    cleanup: { name, sessionId: spec.sessionId || null },
  };
}

function cleanupNativeAgents(opts?: any) {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const name = opts.name ? String(opts.name) : null;
  const sessionId = opts.sessionId == null ? null : String(opts.sessionId);
  let removed = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f: string) => (f.startsWith(TEMP_PREFIX) || f.startsWith(TICKET_PREFIX)) && f.endsWith('.md')); } catch (_) { return { removed }; }
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

function hasStableMarker(source?: any) {
  return source.includes(MARKER) || source.includes(LEGACY_MARKER);
}


const INSTALL_HASH_FILE = '.sidequest-install-hash';

function stableInstallHash(skills = EXECUTOR_SKILLS, readOnlyDeniedTools?: any) {
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || version;
  } catch (_) {}
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const readOnlyTools = resolveReadOnlyTools(readOnlyDeniedTools);
  return crypto.createHash('sha256')
    .update(JSON.stringify({ version, template, marker: MARKER, dispatchModel: DISPATCH_MODEL_ID, checkpointToolRounds: EXECUTOR_CHECKPOINT_TOOL_ROUNDS, readOnlyTools, skills }))
    .digest('hex');
}

function installHashPath(dir?: string) {
  return path.join(dir || defaultAgentsDir(), INSTALL_HASH_FILE);
}

function readInstallHash(dir?: string) {
  try {
    return fs.readFileSync(installHashPath(dir), 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function writeInstallHash(dir: string, hash: string) {
  fs.writeFileSync(installHashPath(dir), hash + '\n');
}

function syncExecAgentsIfChanged(_prefs?: any, opts?: SyncOptions): FastSyncResult {
  const dir = opts && opts.dir ? opts.dir : defaultAgentsDir();
  const readOnlyDeniedTools = opts && opts.readOnlyDeniedTools;
  const installHash = stableInstallHash(EXECUTOR_SKILLS, readOnlyDeniedTools);
  if (readInstallHash(dir) === installHash) {
    return { written: 0, removed: 0, unchanged: 0, skipped: true, installHash };
  }
  const result = syncExecAgents(_prefs, { dir, readOnlyDeniedTools });
  return Object.assign({}, result, { skipped: false, installHash });
}

// Sync the complete stable Claude and Codex dispatch executor ladders. An old
// session can still add legacy definitions during version skew, but this sync
// owns and prunes them without ever touching generation-two files it did not write.
function syncExecAgents(_prefs?: any, opts?: SyncOptions): SyncResult {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const readOnlyDeniedTools = opts.readOnlyDeniedTools;
  const wanted = new Map();
  // Two Codex executors cover every model x every effort: both ride the dispatch
  // marker. The Claude ladder stays per-effort because frontmatter is the only effort
  // carrier on that path.
  wanted.set(`${stableDispatchName()}.md`, renderDispatchAgent());
  wanted.set(`${stableReadOnlyDispatchName()}.md`, renderReadOnlyDispatchAgent(undefined, readOnlyDeniedTools));
  for (const effort of EXEC_EFFORTS) {
    wanted.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER,
    }));
    wanted.set(`${stableReadOnlyClaudeName(effort)}.md`, renderReadOnlyClaudeAgent(effort, readOnlyDeniedTools));
  }

  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((f: string) => f.toLowerCase().endsWith('.md'));
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
    if (prev !== null && !hasStableMarker(prev)) continue;
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
    if (body == null || !hasStableMarker(body)) continue; // never delete an unmarked file
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (_) {
      /* best effort */
    }
  }

  writeInstallHash(dir, stableInstallHash(EXECUTOR_SKILLS, readOnlyDeniedTools));
  return { written, removed, unchanged };
}

module.exports = {
  LEGACY_MARKER,
  MARKER,
  TEMP_MARKER,
  TEMP_PREFIX,
  TICKET_PREFIX,
  RELOAD_NOTICE,
  RESTART_NOTICE,
  ARTIFACT_LIFECYCLE_MARKER,
  NON_MAX_EFFORTS,
  EXECUTOR_CHECKPOINT_TOOL_ROUNDS,
  DISPATCH_MODEL_ID,
  READ_ONLY_DENIED_TOOLS,
  resolveReadOnlyTools,
  EXECUTOR_SKILLS,
  ticketCommentsPacket,
  ticketAssetsPacket,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderReadOnlyDispatchAgent,
  renderReadOnlyClaudeAgent,
  renderExecAgent,
  renderTicketBriefing,
  taskAndScopeBody,
  createNativeAgent,
  cleanupNativeAgents,
  nativeAgentName,
  nativeAgentSource,
  withProjectIdentity,
  renderDispatchStub,
  ensureDispatchLauncher,
  agentSpawn,
  spawnDescription,
  ticketIsolation,
  syncExecAgents,
  syncExecAgentsIfChanged,
  stableInstallHash,
  EXECUTOR_CONTRADICTION_RULE,
  defaultAgentsDir,
};
