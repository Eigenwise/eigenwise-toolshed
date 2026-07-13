'use strict';
/**
 * Tests for the UserPromptSubmit / SessionStart hooks.
 *
 * These lock in the 2026-07 token diet. Hook output is UNCACHED context on the
 * turn it fires and then sits in the transcript for the rest of the session, so
 * the per-prompt hook was the plugin's most expensive surface: it used to emit
 * a ~600-token doctrine block on EVERY prompt ("~95% off the main thread",
 * "scout before reading ~4+ files"), which is exactly the over-orchestration
 * users then saw. The regime now:
 *
 *   - The no-marker standing reminder is ONE short line. The full doctrine
 *     lives in SessionStart (which re-fires on compact/resume) and the skill.
 *   - SessionStart carries the execution economy: expensive orchestrator,
 *     cheap executors — route work DOWN to each ticket's stamped tier as
 *     SHORT, bounded runs that bounce back fast; batch small same-tier tickets
 *     into one executor; inline only trivial one-steps.
 *   - Every block has a byte budget asserted here, so the blocks can't quietly
 *     grow back.
 *   - Earlier fixes stay locked: over-broad capture markers stay pruned
 *     (SQ-106), and capture/mgmt blocks keep a (now one-line) discipline
 *     footer so an action prompt doesn't lose it entirely.
 *
 * The hooks are Node scripts that read a JSON payload on stdin and print a
 * hookSpecificOutput envelope on stdout, so we exercise them as subprocesses
 * over sample prompts and assert on the injected additionalContext.
 *
 * Run: node --test plugins/sidequest/test/hooks.test.js
 * (the directory form of `node --test` is broken on this Node v22/Windows setup)
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

// A throwaway store home so the SubagentStop hook (which loads lib/store.js as a
// subprocess and inherits this env) reads a fixture board, never the real one. The
// other hooks in this file don't touch the store, so this redirect is harmless to
// them. Set BEFORE requiring store so its lazy home resolution picks it up.
const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const store = require('../lib/store.js');
const { slug } = store.ensureProject(path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board'));

const HOOKS = path.join(__dirname, '..', 'hooks');
const CAPTURE = path.join(HOOKS, 'capture-nudge.js');
const SESSION = path.join(HOOKS, 'session-start.js');
const FORCE_BYPASS = path.join(HOOKS, 'force-exec-bypass.js');
const SUBAGENT_STOP = path.join(HOOKS, 'subagent-stop.js');
const GUARD_PEER = path.join(HOOKS, 'guard-peer-message.js');

// Byte budgets (chars ≈ tokens × ~4). CLI paths inside the blocks vary by
// machine, so these have headroom — the point is catching a doctrine block
// growing back to its old ~2.5KB size, not byte-exact accounting.
const BUDGET = {
  standing: 400, // the every-prompt line — keep this one genuinely tiny
  session: 2450, // once per session start
  compact: 600, // once per compact/resume
  capture: 1500, // marker-gated
  mgmt: 1600, // marker-gated
  longrun: 400, // SubagentStop runaway note — one short line, like the standing reminder
};

// Run a hook with the given stdin payload and return the injected
// additionalContext string (or '' when the hook stays silent).
function runHookOutput(script, payload) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

function runHook(script, payload) {
  const parsed = runHookOutput(script, payload);
  if (!parsed) return '';
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

const capture = (prompt) => runHook(CAPTURE, { prompt });

const FOOTER_MARK = '— sidequest:';

// Phrases from the retired heavy doctrine that must NOT come back to any block.
const RETIRED = ['95%', 'read ~4+ files', 'AskUserQuestion', 'coreDiscipline'];

function assertNoRetiredDoctrine(ctx, where) {
  for (const phrase of RETIRED) {
    assert.ok(!ctx.includes(phrase), `${where} must not carry retired doctrine ("${phrase}")`);
  }
}

test('pre-tool hook forces bypass on sidequest worktree executors only', () => {
  const original = {
    subagent_type: 'sidequest-exec-high',
    isolation: 'worktree',
    model: 'grade-3',
    name: 'sq36-srs-cards',
    prompt: 'work SQ-36',
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: original });
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, {
    ...original,
    mode: 'bypassPermissions',
  });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');

  const generic = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'code-explorer', isolation: 'worktree' },
  });
  assert.strictEqual(generic, null, 'unrelated worktree agents keep their caller-selected permissions');
});

test('pre-tool hook keeps built-in executor model but removes overrides for pinned Codex and native executors', () => {
  const codex = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-codex-gpt-5-6-terra-high', model: 'fable', name: 'sq210-codex' },
  });
  assert.equal(codex.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(codex.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(codex.systemMessage, /removed the Agent model override/);

  const native = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-native-sq-210-gpt-5-6-terra', model: 'sonnet', name: 'sq210-native' },
  });
  assert.equal(native.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(native.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'sq210-builtin' },
  });
  assert.equal(builtIn.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
});

/* ------------------------------------------------------------------ *
 *  Builtin executors spawned WITHOUT a model must not silently inherit
 *  the session model — resolve the stamped tier from a ref in the prompt,
 *  or deny the spawn when it can't be resolved unambiguously (SQ-232).
 * ------------------------------------------------------------------ */

function fixtureTicket(title, model, effort) {
  return store.createTicket(slug, { title, model, effort, source: 'cli' });
}

test('pre-tool hook: builtin exec without a model injects the stamped tier from a prompt ref', () => {
  const t = fixtureTicket('SQ-232 inject fixture', 'grade-2', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-inject', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'a resolvable spawn must not be denied');
  assert.match(out.systemMessage, /injected "sonnet"/);
  assert.ok(out.systemMessage.includes(t.ref), 'systemMessage must name the ref it resolved from');
});

test('pre-tool hook: builtin exec without a model and no ticket ref in the prompt is denied', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-norefs', prompt: 'go fix the reporter, no ticket named here' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ready --brief/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /model: exec\.model/);
});

test('pre-tool hook: builtin exec without a model and conflicting stamped tiers across refs is denied', () => {
  const a = fixtureTicket('SQ-232 conflict fixture A', 'grade-2', 'high');
  const b = fixtureTicket('SQ-232 conflict fixture B', 'grade-4', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-conflict', prompt: `batch ${a.ref} and ${b.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /conflicting stamped tiers/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /split it per tier/);
});

test('pre-tool hook: builtin exec spawned WITH a model that mismatches the stamp keeps the caller value and warns', () => {
  const t = fixtureTicket('SQ-232 mismatch fixture', 'grade-2', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-mismatch', model: 'opus', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'opus', 'a deliberate cap must be kept, not overwritten');
  assert.match(out.systemMessage, /model "opus" but .* stamp "sonnet"/);
});

test('pre-tool hook: pinned Codex-style executor still strips model even when a ref resolves', () => {
  const t = fixtureTicket('SQ-232 pinned-passthrough fixture', 'grade-3', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-codex-gpt-5-6-terra-high', model: 'fable', name: 'w-pinned', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(out.systemMessage, /removed the Agent model override/);
});


/* ------------------------------------------------------------------ *
 *  CLAUDE_CODE_SUBAGENT_MODEL defeats routing (it overrides both the Agent
 *  model and the frontmatter pin) — so a sidequest executor spawn must be
 *  denied while it's set, not run on the wrong model.
 * ------------------------------------------------------------------ */

function runForceBypassWithEnv(toolInput, envOverrides) {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a pinned Codex executor spawn', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-codex-gpt-5-6-terra-high', name: 'sq-env-codex', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /CLAUDE_CODE_SUBAGENT_MODEL/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /defeat(s|ing) routing/);
});

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a builtin executor spawn too', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-high', name: 'sq-env-builtin', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Unset it/);
});

test('pre-tool hook: an unset CLAUDE_CODE_SUBAGENT_MODEL leaves the spawn alone', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-codex-gpt-5-6-terra-high', model: 'fable', name: 'sq-env-off', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: '' }
  );
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'no override -> no deny');
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined, 'the pin still wins by stripping the Agent model');
});

/* ------------------------------------------------------------------ *
 *  Peer-message guard — an executor reports UP (final message + its own
 *  ticket comments), never sideways to a peer. This is the other half of
 *  the Contractify loop.
 * ------------------------------------------------------------------ */

function runGuardPeer(payload) {
  const out = execFileSync(process.execPath, [GUARD_PEER], {
    input: JSON.stringify({ tool_name: 'SendMessage', ...payload }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('peer-guard: an executor messaging a peer is denied', () => {
  const out = runGuardPeer({ agent_type: 'sidequest-exec-high', tool_input: { to: 'reviewer', message: 'look at SQ-70' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /report UP/i);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /reviewer/);
});

test('peer-guard: a Codex executor messaging a peer is denied', () => {
  const out = runGuardPeer({ agent_type: 'sidequest-exec-codex-gpt-5-6-luna-medium', tool_input: { to: 'other-worker', message: 'hi' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('peer-guard: an executor reporting to main is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'sidequest-exec-high', tool_input: { to: 'main', message: 'done' } }), null);
});

test('peer-guard: a main-thread SendMessage (no agent_type) is allowed', () => {
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'reviewer', message: 'assign' } }), null);
});

test('peer-guard: a non-sidequest subagent messaging a peer is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'code-reviewer', tool_input: { to: 'researcher', message: 'hi' } }), null);
});

test('session-start: carries the route-down + tight-loop doctrine', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes('ATOMIC'), 'must demand atomic tickets (stuck executors come from oversized scope)');
  assert.match(ctx, /independently checkable/, 'must split independently checkable pieces');
  assert.match(ctx, /investigation, spike, or review/, 'a ticket can be investigation, not only a code change');
  assert.match(ctx, /Split for parallelism/, 'must frame splitting as parallel fan-out, not only cheap execution');
  assert.match(ctx, /tightly coupled work together/, 'must keep coupled work in one ticket');
  for (const field of ['exact anchors', 'contract', 'bounds/non-goals', 'dependencies/decisions']) {
    assert.ok(ctx.includes(field), `must require ${field} in the ticket spec`);
  }
  assert.match(ctx, /verify command, or the artifact\/answer/, 'done is a verify command for a change or an artifact/answer for an investigation');
  assert.ok(ctx.includes('DOWN'), 'must say execution routes down to the stamped tier');
  assert.ok(ctx.includes('exec.agent'), 'must use the ticket-provided persistent executor');
  assert.ok(ctx.includes('already-registered'), 'must explain why it must not create a temporary agent at dispatch time');
  assert.ok(ctx.includes('Do not use `native_agent`'), 'must reject temporary native dispatch for normal execution');
  assert.ok(ctx.includes('bypassPermissions'), 'must require unattended executors to launch in bypass');
  assert.ok(ctx.includes('SHORT'), 'must demand short, bounded executor runs');
  assert.ok(ctx.includes('bounce back'), 'must tell executors to bounce back, not wander');
  assert.ok(ctx.includes('ONE executor'), 'must carry the batch-small-tickets rule');
  assert.ok(ctx.includes('trivial one-step'), 'inline is only for trivial one-steps');
  assert.ok(
    ctx.includes('mcp__plugin_sidequest_board__') && ctx.includes('FIRST'),
    'must push the MCP tools as the first-choice board interface (models default to the CLI out of habit)'
  );
});

test('session-start: carries runtime resource and worker reporting coordination', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /Before each wave, assess shared runtime resources/, 'must require pre-wave assessment');
  assert.match(ctx, /fixed ports, domains, shared DBs, servers, and files outside declared scope/, 'must name runtime collisions');
  assert.match(ctx, /Serialize tickets that touch the same resource even across worktrees/, 'worktrees cannot make shared runtime resources parallel-safe');
  assert.match(ctx, /Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup/, 'must define worker reporting and ownership');
});

test('session-start: flags enumerated deliverables as a decomposition smell (design→wave)', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /several deliverables .* is a smell/, 'a ticket owning several enumerated deliverables must read as a smell');
  assert.match(ctx, /scout that pins the shared contract/, 'must prefer a cheap scout that pins the shared contract');
  assert.match(ctx, /wave fanning the pieces out/, 'then a wave that fans the deliverables out to parallel sub-agents');
});

test('session-start: says sidequest coexists with an external tracker (Jira)', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(ctx.includes('external tracker'), 'must address the external-tracker case');
  assert.ok(ctx.includes('Jira'), 'must name Jira so the "already tracked" reflex is countered');
});

test('session-start: stays inside its byte budget and off the retired doctrine', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(
    ctx.length <= BUDGET.session,
    `session block is ${ctx.length} chars — budget is ${BUDGET.session}; trim it, don't raise the budget`
  );
  assertNoRetiredDoctrine(ctx, 'session-start');
});

test('session-start: source=compact gets the terse re-grounding block, not the full nudge', () => {
  const ctx = runHook(SESSION, { session_id: 't', source: 'compact' });
  assert.match(ctx, /sidequest \(active — context restored\)/);
  assert.ok(ctx.includes('list --status doing'), 'must tell Claude to re-check in-flight claims');
  assert.ok(!ctx.includes('external tracker'), 'must NOT be the full block on compact');
  assert.ok(ctx.length <= BUDGET.compact, `compact block is ${ctx.length} chars — budget is ${BUDGET.compact}`);
});

test('session-start: source=startup still gets the full block', () => {
  const ctx = runHook(SESSION, { session_id: 't', source: 'startup' });
  assert.ok(ctx.includes('external tracker'), 'startup source must still carry the full nudge');
});

test('session-start: SIDEQUEST_NUDGE=off silences it', () => {
  const out = execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_NUDGE: 'off' },
  });
  assert.strictEqual(out.trim(), '', 'should emit nothing when nudge is off');
});

/* ------------------------------------------------------------------ *
 *  Standing reminder — the no-marker path is ONE short line
 * ------------------------------------------------------------------ */

test('standing reminder: plain task prompt gets one short line, not a doctrine block', () => {
  const ctx = capture('add a new export format to the reporter');
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes('tickets'), 'must still point at the board');
  assert.ok(
    ctx.length <= BUDGET.standing,
    `standing reminder is ${ctx.length} chars — budget is ${BUDGET.standing}; this fires EVERY prompt`
  );
  assertNoRetiredDoctrine(ctx, 'standing reminder');
});

test('standing reminder: SIDEQUEST_NUDGE=off silences it (marker blocks still fire)', () => {
  const env = { ...process.env, SIDEQUEST_NUDGE: 'off' };
  const plain = execFileSync(process.execPath, [CAPTURE], {
    input: JSON.stringify({ prompt: 'add a new export format' }),
    encoding: 'utf8',
    env,
  });
  assert.strictEqual(plain.trim(), '', 'no-marker path should emit nothing when nudge is off');
  const defect = execFileSync(process.execPath, [CAPTURE], {
    input: JSON.stringify({ prompt: 'the login form is broken' }),
    encoding: 'utf8',
    env,
  });
  assert.ok(defect.includes('capture the side quest'), 'capture block must still fire when nudge is off');
});

/* ------------------------------------------------------------------ *
 *  Capture block
 * ------------------------------------------------------------------ */

test('capture block: fires on a defect prompt, carries the filing command + footer, inside budget', () => {
  const ctx = capture('the login form is broken');
  assert.ok(ctx.includes('capture the side quest'), 'a defect prompt should hit the capture block');
  assert.ok(ctx.includes('ticket-filer'), 'must prefer the background ticket-filer');
  assert.ok(ctx.includes('--complexity'), 'must show the required complexity flag');
  assert.ok(ctx.includes(FOOTER_MARK), 'must keep the one-line discipline footer');
  assert.ok(ctx.length <= BUDGET.capture, `capture block is ${ctx.length} chars — budget is ${BUDGET.capture}`);
  assertNoRetiredDoctrine(ctx, 'capture block');
});

/* ------------------------------------------------------------------ *
 *  Board-management block
 * ------------------------------------------------------------------ */

test('board-management block: fires on a dashboard prompt, carries claim discipline, inside budget', () => {
  const ctx = capture('show me the dashboard');
  assert.ok(ctx.includes('board control'), 'a dashboard prompt should hit the mgmt block');
  assert.ok(ctx.includes('claim'), 'must carry the claim-first rule');
  assert.ok(
    ctx.indexOf('mcp__plugin_sidequest_board__') < ctx.indexOf('dashboard    —'),
    'the MCP tools must LEAD the block, before any concrete CLI command (concrete beats abstract)'
  );
  assert.ok(ctx.includes(FOOTER_MARK), 'must keep the one-line discipline footer');
  assert.ok(ctx.length <= BUDGET.mgmt, `mgmt block is ${ctx.length} chars — budget is ${BUDGET.mgmt}`);
  assertNoRetiredDoctrine(ctx, 'mgmt block');
});

test('an SQ-ref prompt routes to the board-management block', () => {
  const ctx = capture('close SQ-3');
  assert.ok(ctx.includes('board control'), 'an SQ-\\d+ ref should hit the mgmt block');
});

/* ------------------------------------------------------------------ *
 *  Marker pruning — ordinary task verbs no longer trip capture (SQ-106)
 * ------------------------------------------------------------------ */

test("pruned markers: 'needs to' / 'missing' no longer trip the capture block", () => {
  const ctx = capture('the parser needs to handle the missing config field');
  assert.ok(
    !ctx.includes('capture the side quest'),
    "'needs to'/'missing' are ordinary task words and must not fire capture"
  );
  assert.match(ctx, /sidequest \(active\)/, 'it should fall through to the standing reminder');
});

test("pruned markers: \"won't\" no longer trips the capture block", () => {
  const ctx = capture("the build won't finish on my machine");
  assert.ok(!ctx.includes('capture the side quest'), '"won\'t" must not fire capture on its own');
});

test('genuine defect words still trip capture', () => {
  // 'crash' is deliberately kept — a real "X crashed" report should still file.
  assert.ok(capture('the exporter crashes on empty input').includes('capture the side quest'));
  assert.ok(capture('oh and the contact form is broken').includes('capture the side quest'));
});

/* ------------------------------------------------------------------ *
 *  SubagentStop — flag a runaway (likely non-atomic) executor run post-hoc.
 *
 *  The hook can't stop a running subagent; it turns a long claim into ONE visible
 *  line so the orchestrator notices the ticket wasn't atomic. Elapsed comes from
 *  the claim's OWN start `at` in the worker registry (store already records it),
 *  NOT from the SubagentStop stdin — which we pass BARE here to prove that. We
 *  simulate a 28-min run by backdating the registry claim, then run the hook.
 * ------------------------------------------------------------------ */

let sqSeq = 0;
function addTicket(title) {
  return store.createTicket(slug, {
    title,
    complexity: 3,
    complexityWhy: 'fixture for the SubagentStop runaway-flag hook, single mechanical claim',
    source: 'cli',
  });
}

// Backdate every claim the registry attributes to `sessionId` by `minutesAgo`, so
// the claim's `at` reads as an old, long-running run without waiting real time.
function backdateSessionClaims(sessionId, minutesAgo) {
  const wf = path.join(SIDEQUEST_HOME, 'projects', 'workers.json');
  const w = JSON.parse(fs.readFileSync(wf, 'utf8'));
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (const c of w.sessions[sessionId].claims) c.at = at;
  w.sessions[sessionId].updatedAt = at;
  fs.writeFileSync(wf, JSON.stringify(w));
}

test('subagent-stop: an over-threshold claim emits a one-line runaway note', () => {
  const sess = `sess-long-${++sqSeq}`;
  const t = addTicket('runaway 28-min ticket');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-long', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28); // default threshold is 15m

  // Payload is deliberately BARE (no duration/tokens) — the hook must derive
  // elapsed from the store, not from stdin.
  const ctx = runHook(SUBAGENT_STOP, { session_id: sess });
  assert.ok(ctx, 'an over-threshold claim must produce a note');
  assert.ok(ctx.includes(t.ref), `the note must name the ticket ref (${t.ref})`);
  assert.match(ctx, /~\d+m/, 'the note must state the elapsed minutes');
  assert.match(ctx, /atomic/i, 'the note must ask whether the ticket was atomic');
  assert.ok(ctx.length <= BUDGET.longrun, `runaway note is ${ctx.length} chars — budget is ${BUDGET.longrun}`);
  assert.ok(ctx.indexOf('\n') === -1, 'the note must stay ONE line');
});

test('subagent-stop: stop_hook_active suppresses the note (no self-continuation loop)', () => {
  const sess = `sess-active-${++sqSeq}`;
  const t = addTicket('over-threshold ticket, but re-entrant fire');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-active', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, stop_hook_active: true }),
    '',
    'a fire carrying stop_hook_active is our own continuation and must never re-emit'
  );
});

test('subagent-stop: a non-executor child (reviewer) is not nagged about a session claim', () => {
  const sess = `sess-reviewer-${++sqSeq}`;
  const t = addTicket('over-threshold executor claim, unrelated reviewer stops');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-rev', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'code-reviewer' }),
    '',
    'a reviewer shares the session id but never held the claim — it must stay silent'
  );
  // The same over-threshold claim still surfaces for the actual executor child.
  const ctx = runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'sidequest-exec-high' });
  assert.ok(ctx.includes(t.ref), 'a sidequest executor child must still get the note');
});

test('subagent-stop: the same long run is flagged once, not on every child stop', () => {
  const sess = `sess-dedupe-${++sqSeq}`;
  const t = addTicket('over-threshold claim flagged exactly once');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-dedupe', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  const first = runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'sidequest-exec-high' });
  assert.ok(first.includes(t.ref), 'the first stop must surface the runaway note');
  const second = runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'sidequest-exec-high' });
  assert.strictEqual(second, '', 'a second stop for the same claim must not re-inject the note');
});

test('subagent-stop: a fresh (under-threshold) claim stays silent', () => {
  const sess = `sess-fresh-${++sqSeq}`;
  const t = addTicket('quick ticket, just claimed');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-fresh', { sessionId: sess }).ok, true);
  // No backdating: the claim `at` is ~now, well under the 15m default.
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: sess }), '', 'a fresh claim must not fire');
});

test('subagent-stop: a completed executor is silent even when its registry entry lingers', () => {
  const sess = `sess-completed-${++sqSeq}`;
  const t = addTicket('completed ticket with stale worker entry');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-completed', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(store.completeTicket(slug, t.ref, 'worker-completed', {}).ok, true);

  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: sess }), '', 'a terminal ticket must not wake its finished executor');
});

test('subagent-stop: a prior owner is silent after another worker reclaims the ticket', () => {
  const sess = `sess-prior-owner-${++sqSeq}`;
  const t = addTicket('reclaimed ticket with stale prior owner entry');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-prior', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-prior', {}).ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-current', { sessionId: `sess-current-${sqSeq}` }).ok, true);

  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: sess }), '', 'a prior owner must not be warned about another worker\'s live claim');
});
test('subagent-stop: a session with no attributable claim stays silent', () => {
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: 'sess-nobody-here' }), '', 'unknown session must be silent');
  assert.strictEqual(runHook(SUBAGENT_STOP, {}), '', 'a bare payload with no session id must be silent');
});

test('subagent-stop: SIDEQUEST_LONG_RUN_MIN lowers the threshold', () => {
  const sess = `sess-tuned-${++sqSeq}`;
  const t = addTicket('5-min run, flagged only under a tighter threshold');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-tuned', { sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 5);

  // Default 15m: silent.
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: sess }), '', '5m is under the 15m default');
  // Override to 2m: now it fires.
  const out = execFileSync(process.execPath, [SUBAGENT_STOP], {
    input: JSON.stringify({ session_id: sess }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_LONG_RUN_MIN: '2' },
  });
  const parsed = out.trim() ? JSON.parse(out) : null;
  const ctx = parsed ? parsed.hookSpecificOutput.additionalContext : '';
  assert.ok(ctx.includes(t.ref), 'with a 2m threshold a 5m run must be flagged');
  assert.match(ctx, /over the 2m/, 'the note must reflect the overridden threshold');
});
