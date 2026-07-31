'use strict';

const path = require('node:path');

const { usageTotal } = require('../stream.js');

const MAX_FILES = 500;

// Wall-clock between the first event and the first change includes however long the session sat
// waiting on a human. Gaps longer than this are treated as idle so the reported cost is time actually
// spent orienting, which is the number a map entry would win back.
const IDLE_GAP_MS = 120000;

function actorKey(actor) {
  return actor.scope === 'main' ? 'main-loop' : `subagent:${actor.agentType ?? actor.agentId}`;
}

function targetOf(event) {
  const input = event.input ?? {};
  return input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? null;
}

/**
 * Measures what each transcript spends before it does anything, in both wall time and tokens.
 *
 * Tokens are reconciled per request key rather than summed per record: a retried request appears more
 * than once with the same key and only the last copy carries the settled counts, so a naive sum
 * overstates the cost several times over. The files read most often across transcripts are the ones a
 * codebase-map entry would stop everyone from re-deriving.
 */
function createRediscoveryDetector() {
  const runs = [];
  const filesRead = new Map();
  let current = null;

  const start = (event) => ({
    actor: actorKey(event.actor),
    scope: event.actor.scope,
    agentType: event.actor.agentType ?? null,
    model: event.actor.model ?? null,
    sessionId: event.sessionId,
    startMs: event.timestampMs,
    lastMs: event.timestampMs,
    activeMs: 0,
    reads: 0,
    usage: new Map(),
    files: [],
    settled: false,
  });

  return {
    name: 'rediscovery',

    onEvent(event) {
      if (!current) current = start(event);
      if (current.settled) return;
      if (event.timestampMs) {
        const gap = current.lastMs ? event.timestampMs - current.lastMs : 0;
        if (gap > 0 && gap <= IDLE_GAP_MS) current.activeMs += gap;
        current.lastMs = event.timestampMs;
      }

      if (event.kind === 'assistant') {
        if (event.requestKey && event.usage) current.usage.set(event.requestKey, event.usage);
        return;
      }
      if (event.kind !== 'tool_use') return;

      if (event.mutating) {
        current.settled = true;
        return;
      }
      if (!event.reading) return;

      current.reads += 1;
      const target = targetOf(event);
      if (target) {
        if (current.files.length < 40) current.files.push(String(target));
        const key = path.basename(String(target));
        if (filesRead.size < MAX_FILES || filesRead.has(key)) {
          const entry = filesRead.get(key) ?? { basename: key, reads: 0, transcripts: new Set(), actors: new Set() };
          entry.reads += 1;
          entry.transcripts.add(`${event.sessionId}:${actorKey(event.actor)}`);
          entry.actors.add(actorKey(event.actor));
          filesRead.set(key, entry);
        }
      }
    },

    onTranscriptEnd() {
      if (current) {
        let tokens = 0;
        for (const usage of current.usage.values()) tokens += usageTotal(usage).fresh;
        current.tokens = tokens;
        current.elapsedMs = current.activeMs;
        current.usage = null;
        runs.push(current);
      }
      current = null;
    },

    finish() {
      const meaningful = runs.filter((run) => run.reads >= 3);
      if (!meaningful.length) return { findings: [], notes: { transcripts: runs.length } };

      const byActor = new Map();
      for (const run of meaningful) {
        const entry = byActor.get(run.actor) ?? { actor: run.actor, scope: run.scope, model: run.model, runs: 0, reads: 0, tokens: 0, elapsedMs: 0 };
        entry.runs += 1;
        entry.reads += run.reads;
        entry.tokens += run.tokens ?? 0;
        entry.elapsedMs += run.elapsedMs ?? 0;
        byActor.set(run.actor, entry);
      }

      const totals = meaningful.reduce(
        (acc, run) => ({
          reads: acc.reads + run.reads,
          tokens: acc.tokens + (run.tokens ?? 0),
          elapsedMs: acc.elapsedMs + (run.elapsedMs ?? 0),
        }),
        { reads: 0, tokens: 0, elapsedMs: 0 },
      );

      const hotFiles = [...filesRead.values()]
        .map((entry) => ({ basename: entry.basename, reads: entry.reads, transcripts: entry.transcripts.size, actors: entry.actors.size }))
        .filter((entry) => entry.transcripts >= 2)
        .sort((a, b) => b.transcripts - a.transcripts || b.reads - a.reads)
        .slice(0, 12);

      const minutes = Math.round(totals.elapsedMs / 60000);
      const finding = {
        kind: 'rediscovery-tax',
        title: `${totals.reads} orienting reads before any change, costing ~${minutes} min of active time and ~${Math.round(totals.tokens / 1000)}k fresh tokens`,
        occurrences: meaningful.length,
        sessions: new Set(meaningful.map((run) => run.sessionId)).size,
        actors: [...byActor.values()]
          .sort((a, b) => b.tokens - a.tokens)
          .map((entry) => ({ label: entry.actor, count: entry.runs, tokens: entry.tokens, reads: entry.reads })),
        hotFiles,
        evidence: [
          { label: 'cost', text: `${totals.reads} reads, ~${minutes} min of active time, ~${totals.tokens.toLocaleString('en-US')} fresh tokens across ${meaningful.length} transcripts (cache reads excluded)` },
          {
            label: 're-read everywhere',
            text: hotFiles.length
              ? hotFiles.slice(0, 6).map((file) => `${file.basename} (${file.transcripts} transcripts)`).join(', ')
              : 'no single file dominates; the tax is spread across one-off reads',
          },
        ],
      };

      return { findings: [finding], notes: { transcripts: runs.length, measured: meaningful.length } };
    },
  };
}

module.exports = { createRediscoveryDetector };
