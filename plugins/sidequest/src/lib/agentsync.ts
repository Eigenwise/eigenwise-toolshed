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
 * advertise `model: null`. Codex routes share ONE executor per effort
 * (sidequest-exec-dispatch-<effort>.md, pinned to the virtual claude-codex-auto):
 * the real model rides each dispatch briefing as a [sidequest-route model=...]
 * marker the codex-gateway shim resolves per request (SQ-347/SQ-348). The def
 * set is therefore fixed — route edits never write or register agent files.
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
const { spawnDescription } = store;

type SyncOptions = { dir?: string };
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

// Effort-scaled hard caps stamped into every executor definition's `maxTurns`
// frontmatter — the harness's runaway backstop, not a work budget. Legitimately
// scoped atomic tickets should finish well below it. Complements (does not
// replace) the SubagentStop wall-clock tripwire: maxTurns bounds turns, not minutes.
const EXEC_MAX_TURNS: Record<string, number> = { low: 50, medium: 100, high: 150, xhigh: 200, max: 250 };

// The cap for one effort tier. SIDEQUEST_EXEC_MAX_TURNS, when set to a positive
// integer, overrides ALL tiers; garbage or non-positive values are ignored and
// the effort default applies. Read at render time so a sync pass sees the
// current environment.
function execMaxTurns(effort?: any) {
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
const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'ToolSearch', 'SendMessage', 'mcp__plugin_sidequest_board__*',
];

function readOnlyNote() {
  return '\n\n**Read-only role:** Your tools cannot change files. If this ticket requires an edit, write a board blocker comment naming the needed change and why, then release the ticket. Do not try to work around the tool restriction.';
}

function renderExecAgent({ name, effort, modelId, marker, extraNote, ticketBrief, tools }: any) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const toolsLine = Array.isArray(tools) && tools.length ? `tools: ${tools.join(', ')}\n` : '';
  return template
    .split('{{NAME}}').join(String(name))
    .split('{{EFFORT}}').join(String(effort))
    .split('{{MODEL_FRONTMATTER}}').join(modelId ? `\nmodel: ${modelId}` : '')
    .split('{{MAX_TURNS}}').join(String(execMaxTurns(String(effort))))
    .split('{{CHECKPOINT_TOOL_ROUNDS}}').join(String(EXECUTOR_CHECKPOINT_TOOL_ROUNDS))
    .split('permissionMode: bypassPermissions').join(`${toolsLine}permissionMode: bypassPermissions`)
    .split('{{MARKER}}').join(marker || '')
    .split('{{EXTRA_NOTE}}').join(extraNote || '')
    .split('{{TICKET_BRIEF}}').join(`Teammate subagent fan-out must omit the Agent \`name\` parameter; named teammate spawns are rejected by the harness.${ticketBrief ? `\n\n${ticketBrief}` : ''}`);
}

// Appended to every shared dispatch executor's body. Effort is set via Claude
// Code's frontmatter, which the shim forwards to the Codex backend's
// reasoning.effort; the model is NOT in the def — the shim resolves it from the
// briefing's route marker, so the note bans writing that marker anywhere else
// (the gateway takes the last occurrence in the conversation).
function dispatchNote(effort?: any) {
  return `\n\n_This agent is the shared Sidequest executor for every Codex-backed route at \`${effort}\` effort. Its \`model: ${DISPATCH_MODEL_ID}\` pin is virtual: the codex-gateway shim resolves the real Codex model from the \`[sidequest-route model=... effort=...]\` line in your spawn prompt, whose effort mirrors this def frontmatter for gateway-side audit, so NEVER write, quote, or echo such a line anywhere else. If the gateway reports a missing route marker, stop and report it — the orchestrator must redispatch. Refuse a batch whose tickets are stamped with different models: one spawn carries exactly one route marker. The \`effort\` frontmatter above is forwarded to the model's reasoning effort._`;
}

function renderDispatchAgent(effort?: any) {
  return renderExecAgent({
    name: stableDispatchName(effort),
    effort,
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: dispatchNote(effort),
  });
}

function renderReadOnlyDispatchAgent(effort?: any) {
  return renderExecAgent({
    name: stableReadOnlyDispatchName(effort),
    effort,
    modelId: DISPATCH_MODEL_ID,
    marker: MARKER,
    extraNote: `${dispatchNote(effort)}${readOnlyNote()}`,
    tools: READ_ONLY_TOOLS,
  });
}

function renderReadOnlyClaudeAgent(effort?: any) {
  return renderExecAgent({
    name: stableReadOnlyClaudeName(effort),
    effort,
    marker: MARKER,
    extraNote: readOnlyNote(),
    tools: READ_ONLY_TOOLS,
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

function ticketRouteMarker(ticket?: any) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  return resolved && resolved.backend === 'codex' && resolved.dispatchModel
    ? routeMarker(resolved.dispatchModel, ticket.effort)
    : null;
}

function ticketCloseout(ticket?: any) {
  const resolved = store.resolveExec(ticket.model, ticket.effort);
  const effort = resolved && (resolved.effort || ticket.effort);
  return resolved && effort
    ? `Closeout: submit for repo work; otherwise done --model ${resolved.runsModel} --effort ${effort}. Put the full final report in the terminal board comment, then stop without a routine SendMessage.`
    : null;
}

function ticketWorktreeSetup(ticket?: any, slug?: any) {
  if (!ticket || !ticket.dispatch || ticketIsolation(ticket, ticket.dispatch.sharedTree) !== 'worktree') return null;
  const config = store.boardConfig(slug);
  return config && config.worktreeSetup ? config.worktreeSetup : null;
}

function storyContractPacket(ticket?: any, slug?: any) {
  const snapshot = ticket && ticket.dispatch && ticket.dispatch.storyContract
    ? ticket.dispatch.storyContract
    : store.storyExecutionContract(ticket && ticket.storyId ? store.getStory(slug, ticket.storyId) : null);
  if (!snapshot || !snapshot.body) return null;
  return `## Story execution contract (revision ${Number(snapshot.revision) || 1})\n${snapshot.body}`;
}

function ticketBrief(ticket?: any, nonce?: any, marker?: any, slug?: any) {
  const category = ticket.category || {};
  const comments = ticketCommentsPacket(ticket.comments);
  const commentHeading = comments.includes('[Comment packet truncated.')
    ? 'Comment packet (newest-first excerpts; read full history only when flagged below):'
    : 'Complete comment thread (chronological, inspect every entry before implementation):';
  const links = Array.isArray(ticket.links) && ticket.links.length
    ? ticket.links.map((link: any) => `- ${link.type || 'related'}: ${link.ref || '(unknown ticket)'}`).join('\n')
    : '(No ticket dependencies were recorded.)';
  const declaredFiles = Array.isArray(ticket.files) && ticket.files.length
    ? ticket.files.map((file: any) => `- ${file}`).join('\n')
    : '(No files were declared.)';
  const labels = Array.isArray(ticket.labels) && ticket.labels.length ? ticket.labels.join(', ') : '(No labels were recorded.)';
  const closeout = ticketCloseout(ticket);
  const worktreeSetup = ticketWorktreeSetup(ticket, slug);
  const contract = storyContractPacket(ticket, slug);
  const parts = [
    '',
    ...(contract ? [contract] : []),
    '## This ticket',
    `Ref: ${ticket.ref}`,
    `Title: ${ticket.title || '(Untitled ticket)'}`,
    `Description:\n${ticketDescriptionPacket(ticket.description)}`,
    `Category contract:\nCategory: ${category.id || ticket.categoryId || '(Unclassified)'}\nConfigured route: ${category.route?.model || '(No configured route)'} / ${category.route?.effort || '(No configured effort)'}\nDispatch route: ${ticket.model || category.route?.model || '(No route)'} / ${ticket.effort || category.route?.effort || '(No effort)'}\n${category.contract || '(No category-specific executor instructions were recorded.)'}`,
    `Anchors:\n${ticket.executorAnchors || '(No anchors were recorded.)'}`,
    `Verify command:\n${ticket.executorVerify || '(No exact verify command was recorded.)'}`,
    ...(worktreeSetup ? [`Worktree setup (run before verify): ${worktreeSetup}`] : []),
    `Declared files:\n${declaredFiles}`,
    `Ticket state:\nStatus: ${ticket.status || '(Unknown)'}\nPriority: ${ticket.priority || '(Unknown)'}\nLabels: ${labels}\nStory: ${ticket.storyId || '(No story)'}\nDependencies:\n${links}`,
    `${commentHeading}\n${comments}`,
    `Attachments (inspect every readable attachment before implementation):\n${ticketAssetsPacket(ticket, slug)}`,
    ...(closeout ? [closeout] : []),
    'Dispatch claim guard:',
    `Claim this ticket with \`--token ${nonce}\`. A token refusal means this dispatch was superseded or you are not its prepared executor. Stop and report that refusal.`,
  ];
  if (store.sharedTreeArtifactMode(ticket)) {
    parts.push(
      'Artifact lifecycle exception:',
      `${ARTIFACT_LIFECYCLE_MARKER}\nThis shared-tree artifact ticket may leave verified changes in its declared scope and close with done. Do not commit or submit it. All project source remains read-only.`
    );
  }
  if (marker) {
    parts.push('Model route (gateway dispatch marker — never write another):', marker);
  }
  return parts.join('\n\n');
}

// Stable executor definitions carry the invariant protocol as their system
// prompt. The spawn prompt only carries a fetch command and route marker, so
// instant dispatch keeps the durable ticket packet out of the launch request.
function renderTicketBriefing(ticket?: any, nonce?: any, slug?: any) {
  if (typeof nonce !== 'string' || !nonce.trim() || /[\r\n]/.test(nonce)) {
    throw new Error('dispatch briefing nonce is required and must be a non-empty one-line string.');
  }
  return ticketBrief(ticket, nonce.trim(), ticketRouteMarker(ticket), slug);
}

function ticketIsolation(ticket?: any, sharedTree?: any) {
  const hasDeclaredScope = Array.isArray(ticket && ticket.files) && ticket.files.length > 0;
  if (!hasDeclaredScope) return null;
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
    `Prepared Sidequest executor: ${ticket.dispatchExecutor}.`,
    `Ticket: ${ticket.ref}.`,
    `Dispatch board identity: --project ${quotedShellArgument(project)}.`,
    '',
    `FIRST action: run \`${command}\` and execute exactly what it prints.`,
  ].join('\n');
}

function agentSpawn(name?: any, isolation?: any, model?: any, agentType?: any, prompt?: any, description?: any) {
  return Object.assign({ subagent_type: agentType || name, name, mode: 'bypassPermissions' },
    description ? { description } : {}, isolation ? { isolation } : {}, model ? { model } : {}, prompt ? { prompt } : {});
}

function createNativeAgent(spec?: any, opts?: any) {
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

function stableInstallHash() {
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || version;
  } catch (_) {}
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const maxTurnsOverride = String(process.env.SIDEQUEST_EXEC_MAX_TURNS || '').trim();
  return crypto.createHash('sha256')
    .update(JSON.stringify({ version, template, marker: MARKER, dispatchModel: DISPATCH_MODEL_ID, maxTurns: EXEC_MAX_TURNS, checkpointToolRounds: EXECUTOR_CHECKPOINT_TOOL_ROUNDS, maxTurnsOverride, readOnlyTools: READ_ONLY_TOOLS }))
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
  const installHash = stableInstallHash();
  if (readInstallHash(dir) === installHash) {
    return { written: 0, removed: 0, unchanged: 0, skipped: true, installHash };
  }
  const result = syncExecAgents(_prefs, { dir });
  return Object.assign({}, result, { skipped: false, installHash });
}

// Sync the complete stable Claude and Codex dispatch executor ladders. An old
// session can still add legacy definitions during version skew, but this sync
// owns and prunes them without ever touching generation-two files it did not write.
function syncExecAgents(_prefs?: any, opts?: SyncOptions): SyncResult {
  opts = opts || {};
  const dir = opts.dir || defaultAgentsDir();
  const wanted = new Map();
  for (const effort of EXEC_EFFORTS) {
    wanted.set(`${stableDispatchName(effort)}.md`, renderDispatchAgent(effort));
    wanted.set(`${stableClaudeName(effort)}.md`, renderExecAgent({
      name: stableClaudeName(effort),
      effort,
      marker: MARKER,
    }));
    wanted.set(`${stableReadOnlyDispatchName(effort)}.md`, renderReadOnlyDispatchAgent(effort));
    wanted.set(`${stableReadOnlyClaudeName(effort)}.md`, renderReadOnlyClaudeAgent(effort));
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

  writeInstallHash(dir, stableInstallHash());
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
  EXEC_MAX_TURNS,
  DISPATCH_MODEL_ID,
  READ_ONLY_TOOLS,
  execMaxTurns,
  ticketCommentsPacket,
  ticketAssetsPacket,
  routeMarker,
  workflowRecipe,
  renderDispatchAgent,
  renderReadOnlyDispatchAgent,
  renderReadOnlyClaudeAgent,
  renderExecAgent,
  renderTicketBriefing,
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
  defaultAgentsDir,
};
