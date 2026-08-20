'use strict';

const fs = require('node:fs');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_DRAIN_BUDGET_MS = 10_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

function readBoundedLines(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  let text = buffer.toString('utf8');
  if (stat.size > length) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
  }
  return {
    droppedBytes: Math.max(0, stat.size - length),
    lines: text.split(/\r?\n/).filter((line) => line.trim().length > 0),
  };
}

function errorCode(error) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'hook_spool_drain_failed';
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function poisonPath(spoolPath) {
  const date = new Date().toISOString().slice(0, 10);
  const datedPath = `${spoolPath}.poison-${date}`;
  if (!fs.existsSync(datedPath)) return datedPath;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${datedPath}-${suffix}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function recordDrainFailure(options, drainingPath, error) {
  const state = options.failureState;
  if (!state) return;
  state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
  state.last_error = {
    code: errorCode(error),
    message: errorMessage(error),
    file: drainingPath,
    at: new Date().toISOString(),
  };
  const threshold = Math.max(1, Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD);
  if (state.consecutive_failures < threshold) return;
  const quarantinedPath = poisonPath(options.spoolPath);
  fs.renameSync(drainingPath, quarantinedPath);
  state.last_error.quarantined_file = quarantinedPath;
  state.last_quarantined_file = quarantinedPath;
  state.last_quarantined_at = new Date().toISOString();
  state.consecutive_failures = 0;
}

function recordDrainSuccess(options) {
  const state = options.failureState;
  if (!state) return;
  state.consecutive_failures = 0;
  state.last_error = null;
  state.last_success_at = new Date().toISOString();
}

function drainBudgetMs(options) {
  return Math.max(10, Math.min(60_000, Number(options.drainBudgetMs) || DEFAULT_DRAIN_BUDGET_MS));
}

function assertWithinBudget(deadline, startedAt, budgetMs, remainingEntries) {
  const now = Date.now();
  if (now <= deadline) return;
  const elapsedMs = now - startedAt;
  const error = new Error(`Hook spool drain exceeded its ${budgetMs}ms time budget after ${elapsedMs}ms with ${remainingEntries} spool entries remaining.`);
  error.code = 'HOOK_SPOOL_DRAIN_TIMEOUT';
  error.drain_budget_ms = budgetMs;
  error.drain_elapsed_ms = elapsedMs;
  error.remaining_spool_entries = remainingEntries;
  throw error;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drainHookSpool(options) {
  const spoolPath = options && options.spoolPath;
  const store = options && options.store;
  if (!spoolPath || !store || typeof store.ingestBatch !== 'function') {
    throw new TypeError('spoolPath and an ingestBatch store are required');
  }

  const drainingPath = `${spoolPath}.draining`;
  try {
    if (!fs.existsSync(drainingPath)) {
      try {
        fs.renameSync(spoolPath, drainingPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') return { drained: 0, duplicates: 0, rejected: 0, malformed: 0, droppedBytes: 0 };
        throw error;
      }
    }

    const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    const batchSize = Math.max(1, Math.min(1024, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
    const budgetMs = drainBudgetMs(options);
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    const { lines, droppedBytes } = readBoundedLines(drainingPath, maxBytes);
    let drained = 0;
    let duplicates = 0;
    let rejected = 0;
    let malformed = 0;
    for (let offset = 0; offset < lines.length; offset += batchSize) {
      assertWithinBudget(deadline, startedAt, budgetMs, lines.length - offset);
      const batchLines = lines.slice(offset, offset + batchSize);
      const observations = [];
      for (const line of batchLines) {
        try {
          const observation = JSON.parse(line);
          if (options.projectId && !observation.project_id) observation.project_id = options.projectId;
          observations.push(observation);
        } catch {
          malformed += 1;
        }
      }
      if (observations.length > 0) {
        const results = await store.ingestBatch(observations);
        for (const result of results) {
          if (!result.accepted) rejected += 1;
          else if (result.duplicate) duplicates += 1;
          else drained += 1;
        }
      }
      const remainingLines = lines.slice(offset + batchSize);
      if (remainingLines.length === 0) fs.writeFileSync(drainingPath, '');
      else fs.writeFileSync(drainingPath, `${remainingLines.join('\n')}\n`);
      if (remainingLines.length > 0) {
        assertWithinBudget(deadline, startedAt, budgetMs, remainingLines.length);
      }
      await yieldToEventLoop();
    }
    fs.unlinkSync(drainingPath);
    recordDrainSuccess(options);
    return { drained, duplicates, rejected, malformed, droppedBytes };
  } catch (error) {
    if (fs.existsSync(drainingPath) && error?.code !== 'HOOK_SPOOL_DRAIN_TIMEOUT') {
      recordDrainFailure(options, drainingPath, error);
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DRAIN_BUDGET_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MAX_BYTES,
  drainHookSpool,
  readBoundedLines,
};
