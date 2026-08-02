'use strict';

const { commandHead, describeDelta, isTrivialShape, normalizeCommand, shapeComplexity } = require('../normalize.js');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_SHAPES = 4000;
const MAX_PENDING = 600;
const REPEAT_THRESHOLD = 3;
const EVIDENCE_CHARS = 400;
const ERROR_CHARS = 300;
const MERGE_SIMILARITY = 0.6;
const FIX_SIMILARITY = 0.5;
const FIX_WINDOW_MS = 5 * 60 * 1000;
const FIX_MAX_ADDED_TOKENS = 4;

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function similarity(left, right) {
  const a = new Set(String(left).split(/\s+/).filter(Boolean));
  const b = new Set(String(right).split(/\s+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Collapses shapes that survived normalization but describe the same chore, such as the same verify
 * run written as `npm ci --prefix X` in one worktree and `npm --prefix X ci` in the next. Reporting
 * those as eight findings is how a retro turns into a wish-list nobody reads.
 */
function mergeShapes(records) {
  const groups = [];
  for (const record of records) {
    const match = groups.find((group) => group.head === record.head && similarity(group.shape, record.shape) >= MERGE_SIMILARITY);
    if (match) {
      match.variants.push(record);
      if (record.count > match.count) match.shape = record.shape;
      match.count += record.count;
      match.failures += record.failures;
      match.totalDurationMs += record.totalDurationMs;
      match.durationCount += record.durationCount;
      match.complexity = Math.max(match.complexity, record.complexity);
      for (const session of record.sessions) match.sessions.add(session);
      for (const [actor, count] of record.actors) match.actors.set(actor, (match.actors.get(actor) ?? 0) + count);
      continue;
    }
    groups.push({
      head: record.head,
      shape: record.shape,
      count: record.count,
      failures: record.failures,
      totalDurationMs: record.totalDurationMs,
      durationCount: record.durationCount,
      complexity: record.complexity,
      sessions: new Set(record.sessions),
      actors: new Map(record.actors),
      variants: [record],
    });
  }
  return groups;
}

function actorKey(actor) {
  return actor.scope === 'main' ? 'main-loop' : `subagent:${actor.agentType ?? actor.agentId}`;
}

/**
 * Clusters shell invocations by their normalized shape and pairs failures with the retry that fixed
 * them. Both signals come from the same index because a fail-then-fix pair is only interesting when
 * the shape recurs: a one-off typo is noise, the same correction three times is a missing script.
 */
function createCommandDetector() {
  const shapes = new Map();
  const pending = new Map();
  const failuresByHead = new Map();
  const pairs = [];
  let droppedShapes = 0;
  let trivialShapes = 0;

  const track = (event) => {
    const command = event.input?.command;
    if (typeof command !== 'string' || !command.trim()) return null;
    const { shape, slots } = normalizeCommand(command);
    if (!shape) return null;
    const head = commandHead(shape);
    const entry = { shape, head, slots, command, trivial: isTrivialShape(shape) };

    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(event.id, entry);

    if (entry.trivial) {
      trivialShapes += 1;
      return entry;
    }

    let record = shapes.get(shape);
    if (!record) {
      if (shapes.size >= MAX_SHAPES) {
        droppedShapes += 1;
        return entry;
      }
      record = {
        shape,
        head,
        complexity: shapeComplexity(shape),
        count: 0,
        failures: 0,
        totalDurationMs: 0,
        durationCount: 0,
        sessions: new Set(),
        actors: new Map(),
        samples: [],
        slotValues: [],
      };
      shapes.set(shape, record);
    }
    record.count += 1;
    record.sessions.add(event.sessionId);
    const key = actorKey(event.actor);
    record.actors.set(key, (record.actors.get(key) ?? 0) + 1);
    if (record.samples.length < 3) record.samples.push(clip(command, EVIDENCE_CHARS));
    slots.forEach((slot, index) => {
      if (!record.slotValues[index]) record.slotValues[index] = { token: slot.token, values: new Set() };
      if (record.slotValues[index].values.size < 12) record.slotValues[index].values.add(clip(slot.value, 120));
    });
    return entry;
  };

  return {
    name: 'commands',

    onEvent(event) {
      if (event.kind === 'tool_use' && SHELL_TOOLS.has(event.name)) {
        track(event);
        return;
      }
      if (event.kind !== 'tool_result' || !SHELL_TOOLS.has(event.name)) return;

      const entry = pending.get(event.id);
      pending.delete(event.id);
      if (!entry) return;

      const record = shapes.get(entry.shape);
      if (record && Number.isFinite(event.durationMs)) {
        record.totalDurationMs += event.durationMs;
        record.durationCount += 1;
      }
      if (event.isError) {
        if (record) record.failures += 1;
        if (failuresByHead.size >= MAX_PENDING) failuresByHead.delete(failuresByHead.keys().next().value);
        failuresByHead.set(`${event.sessionId}::${entry.head}`, {
          command: entry.command,
          shape: entry.shape,
          error: clip(event.text, ERROR_CHARS),
          sessionId: event.sessionId,
          actor: actorKey(event.actor),
          timestampMs: event.timestampMs,
        });
        return;
      }

      const failure = failuresByHead.get(`${event.sessionId}::${entry.head}`);
      if (!failure || failure.shape === entry.shape) return;
      failuresByHead.delete(`${event.sessionId}::${entry.head}`);

      // A retry only counts as the fix when it is recognizably the same command with a small change.
      // Sharing a head is not enough: two unrelated `npm` calls minutes apart would otherwise be
      // reported as a correction, and a fabricated fix is worse than a missed one.
      const elapsedMs = event.timestampMs && failure.timestampMs ? event.timestampMs - failure.timestampMs : Number.POSITIVE_INFINITY;
      if (elapsedMs > FIX_WINDOW_MS) return;
      if (similarity(failure.shape, entry.shape) < FIX_SIMILARITY) return;
      // The delta is taken between shapes, not raw commands, so the same missing flag discovered in
      // twelve different worktrees is one finding instead of twelve near-identical ones.
      const delta = describeDelta(failure.shape, entry.shape);
      if (delta.added.length > FIX_MAX_ADDED_TOKENS || delta.removed.length > FIX_MAX_ADDED_TOKENS) return;
      if (!delta.added.length && !delta.removed.length) return;

      if (pairs.length < 60) {
        pairs.push({
          head: entry.head,
          shape: entry.shape,
          failed: clip(failure.command, EVIDENCE_CHARS),
          error: failure.error,
          fixed: clip(entry.command, EVIDENCE_CHARS),
          delta,
          sessionId: event.sessionId,
          actor: actorKey(event.actor),
        });
      }
    },

    finish() {
      const eligible = [...shapes.values()].sort((a, b) => b.count - a.count);
      const merged = mergeShapes(eligible)
        .filter((group) => group.count >= REPEAT_THRESHOLD)
        .sort((a, b) => b.totalDurationMs - a.totalDurationMs || b.count * b.complexity - a.count * a.complexity);

      const findings = merged.slice(0, 20).map((group) => {
        const primary = group.variants.reduce((best, record) => (record.count > best.count ? record : best), group.variants[0]);
        const slots = primary.slotValues
          .filter(Boolean)
          .map((slot, index) => ({ position: index + 1, token: slot.token, distinct: slot.values.size, values: [...slot.values].slice(0, 6) }))
          .filter((slot) => slot.distinct > 1);
        return {
          kind: 'repeated-command',
          title: `\`${clip(group.shape, 90)}\` ran ${group.count} times`,
          occurrences: group.count,
          totalDurationMs: group.totalDurationMs,
          averageDurationMs: group.durationCount ? group.totalDurationMs / group.durationCount : null,
          durationCount: group.durationCount,
          sessions: group.sessions.size,
          actors: [...group.actors].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
          complexity: group.complexity,
          failures: group.failures,
          variants: group.variants.length > 1
            ? group.variants.sort((a, b) => b.count - a.count).slice(0, 6).map((record) => ({ shape: clip(record.shape, 120), count: record.count }))
            : [],
          arguments: slots,
          evidence: primary.samples.slice(0, 2).map((sample, index) => ({ label: `invocation ${index + 1}`, text: sample })),
        };
      });

      // A fix is only worth carrying forward when the command it corrects recurs, and each distinct
      // correction is reported once no matter how many worktrees hit it.
      const recurring = new Set(merged.map((group) => group.head));
      const seen = new Set();
      const fixes = [];
      for (const pair of pairs) {
        if (!recurring.has(pair.head)) continue;
        const signature = `${pair.head}::${pair.delta.added.join(' ')}::${pair.delta.removed.join(' ')}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        const change = pair.delta.added.length
          ? `adding \`${pair.delta.added.join(' ')}\``
          : pair.delta.removed.length ? `dropping \`${pair.delta.removed.join(' ')}\`` : 'a change';
        fixes.push({
          kind: 'fail-then-fix',
          title: `\`${pair.head}\` failed, then worked after ${change}`,
          occurrences: 1,
          sessions: 1,
          actors: [{ label: pair.actor, count: 1 }],
          delta: pair.delta,
          evidence: [
            { label: 'failed', text: pair.failed },
            { label: 'error', text: pair.error },
            { label: 'fixed', text: pair.fixed },
          ],
        });
      }

      return {
        findings: [...findings, ...fixes.slice(0, 6)],
        notes: {
          distinctShapes: shapes.size,
          mergedGroups: merged.length,
          reportedShapes: Math.min(merged.length, 20),
          trivialInvocations: trivialShapes,
          candidateFixes: pairs.length,
          reportedFixes: fixes.length,
          droppedShapes,
        },
      };
    },
  };
}

module.exports = { createCommandDetector, REPEAT_THRESHOLD };
