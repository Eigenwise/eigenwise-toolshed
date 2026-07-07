'use strict';
/**
 * Tests for the UserPromptSubmit / SessionStart hooks (SQ-105 / SQ-106 / SQ-109).
 *
 * These lock in three fixes that came out of the "agents ignore the fan-out
 * guidance" investigation (contractify session 634fecde):
 *   - SQ-105: the SessionStart nudge now carries fan-out guidance at all.
 *   - SQ-106: the plan+fan-out discipline is no longer SUPPRESSED when a prompt
 *     trips a capture or board-management marker — those blocks used to
 *     process.exit early, dropping the guidance exactly on the action prompts
 *     that kick off real work. Both blocks now carry the core-discipline footer.
 *     Over-broad capture markers ('needs to' / 'missing' / "won't") were pruned
 *     so ordinary task descriptions stop tripping capture.
 *   - SQ-109: the fan-out line is concrete and trigger-based ("read ~4+ files"
 *     -> spawn an Explore / code-explorer scout), not the abstract "lean
 *     parallel over serial" that got ignored mid-execution even when present.
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

// Run a hook with the given stdin payload and return the injected
// additionalContext string (or '' when the hook stays silent).
function runHook(script, payload) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (!out.trim()) return '';
  const parsed = JSON.parse(out);
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

const capture = (prompt) => runHook(CAPTURE, { prompt });

// Markers of the concrete, trigger-based fan-out guidance (SQ-109). We assert
// on the trigger phrasing and the NAMED tool, since the whole finding was that
// abstract wording gets ignored — the test should fail if someone softens it
// back to vibes.
const CONCRETE_TRIGGER = 'read ~4+ files';
const NAMED_SCOUT = 'Explore / code-explorer';
const FOOTER_MARK = 'sidequest discipline';

/* ------------------------------------------------------------------ *
 *  SessionStart (SQ-105 + SQ-109)
 * ------------------------------------------------------------------ */

test('session-start: carries the concrete, named-tool fan-out guidance', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes('FAN OUT'), 'SessionStart should mention FAN OUT');
  assert.ok(ctx.includes(CONCRETE_TRIGGER), 'fan-out line must be trigger-based, not abstract');
  assert.ok(ctx.includes(NAMED_SCOUT), 'fan-out line must name the scout subagent');
});

test('session-start: says sidequest coexists with an external tracker (Jira)', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(ctx.includes('external tracker'), 'must address the external-tracker case');
  assert.ok(ctx.includes('Jira'), 'must name Jira so the "already tracked" reflex is countered');
});

test('session-start: stresses routed-subagent execution + the model-routing why', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(ctx.includes('routed subagent'), 'must push routed-subagent execution');
  assert.ok(ctx.includes('best model'), 'must give the model-routing reason');
  assert.ok(ctx.includes('95%'), 'must state the ~95%-in-a-subagent bar');
});

test('session-start: source=compact gets the terse re-grounding block, not the full nudge', () => {
  const ctx = runHook(SESSION, { session_id: 't', source: 'compact' });
  assert.match(ctx, /sidequest \(active — context restored\)/);
  assert.ok(ctx.includes('list --status doing'), 'must tell Claude to re-check in-flight claims');
  assert.ok(ctx.includes('context'), 'must mention context being restored/compacted');
  assert.ok(!ctx.includes('external tracker'), 'must NOT be the full block on compact');
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
 *  Standing reminder — the no-marker path (SQ-109)
 * ------------------------------------------------------------------ */

test('standing reminder: plain task prompt gets the concrete fan-out trigger', () => {
  const ctx = capture('add a new export format to the reporter');
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes(CONCRETE_TRIGGER), 'standing reminder must carry the concrete trigger');
  assert.ok(ctx.includes(NAMED_SCOUT), 'standing reminder must name the scout subagent');
});

test('standing reminder: says sidequest coexists with an external tracker (Jira)', () => {
  const ctx = capture('add a new export format to the reporter');
  assert.ok(ctx.includes('external tracker'), 'must address the external-tracker case');
  assert.ok(ctx.includes('Jira'), 'must name Jira so the "already tracked" reflex is countered');
});

test('standing reminder: stresses routed-subagent execution (~95%, not the main thread)', () => {
  const ctx = capture('add a new export format to the reporter');
  assert.ok(ctx.includes('EXECUTE via a routed subagent'), 'must carry the EXECUTE bullet');
  assert.ok(ctx.includes('95%'), 'must state the ~95%-in-a-subagent bar');
  assert.ok(ctx.includes('sidequest-exec-'), 'must name the executor subagent to spawn');
});

/* ------------------------------------------------------------------ *
 *  Discipline is not suppressed by capture / mgmt branches (SQ-106)
 * ------------------------------------------------------------------ */

test('capture block still carries the core-discipline footer', () => {
  const ctx = capture('the login form is broken');
  assert.ok(ctx.includes('capture the side quest'), 'a defect prompt should hit the capture block');
  assert.ok(ctx.includes(FOOTER_MARK), 'capture block must still carry the plan+fan-out footer');
  assert.ok(ctx.includes(CONCRETE_TRIGGER), 'footer must carry the concrete fan-out trigger');
});

test('board-management block still carries the core-discipline footer', () => {
  const ctx = capture('show me the dashboard');
  assert.ok(ctx.includes('board control'), 'a dashboard prompt should hit the mgmt block');
  assert.ok(ctx.includes(FOOTER_MARK), 'mgmt block must still carry the plan+fan-out footer');
  assert.ok(ctx.includes(CONCRETE_TRIGGER), 'footer must carry the concrete fan-out trigger');
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
 *  Board-management routing still works (regression guard)
 * ------------------------------------------------------------------ */

test('an SQ-ref prompt routes to the board-management block', () => {
  const ctx = capture('close SQ-3');
  assert.ok(ctx.includes('board control'), 'an SQ-\\d+ ref should hit the mgmt block');
});
