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
const path = require('path');
const { execFileSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const CAPTURE = path.join(HOOKS, 'capture-nudge.js');
const SESSION = path.join(HOOKS, 'session-start.js');
const FORCE_BYPASS = path.join(HOOKS, 'force-exec-bypass.js');

// Byte budgets (chars ≈ tokens × ~4). CLI paths inside the blocks vary by
// machine, so these have headroom — the point is catching a doctrine block
// growing back to its old ~2.5KB size, not byte-exact accounting.
const BUDGET = {
  standing: 400, // the every-prompt line — keep this one genuinely tiny
  session: 1900, // once per session start
  compact: 600, // once per compact/resume
  capture: 1500, // marker-gated
  mgmt: 1600, // marker-gated
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
    model: 'opus',
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

/* ------------------------------------------------------------------ *
 *  SessionStart — the one full doctrine block
 * ------------------------------------------------------------------ */

test('session-start: carries the route-down + tight-loop doctrine', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes('ATOMIC'), 'must demand atomic tickets (stuck executors come from oversized scope)');
  assert.ok(ctx.includes('DOWN'), 'must say execution routes down to the stamped tier');
  assert.ok(ctx.includes('sidequest-exec-'), 'must name the routed executor');
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
