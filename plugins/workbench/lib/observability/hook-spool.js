'use strict';

const fs = require('node:fs');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 256;

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

function drainHookSpool(options) {
  const spoolPath = options && options.spoolPath;
  const store = options && options.store;
  if (!spoolPath || !store || typeof store.ingestBatch !== 'function') {
    throw new TypeError('spoolPath and an ingestBatch store are required');
  }

  const drainingPath = `${spoolPath}.draining`;
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
  const { lines, droppedBytes } = readBoundedLines(drainingPath, maxBytes);
  const observations = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const observation = JSON.parse(line);
      if (options.projectId && !observation.project_id) observation.project_id = options.projectId;
      observations.push(observation);
    } catch {
      malformed += 1;
    }
  }

  let drained = 0;
  let duplicates = 0;
  let rejected = 0;
  for (let offset = 0; offset < observations.length; offset += batchSize) {
    const results = store.ingestBatch(observations.slice(offset, offset + batchSize));
    for (const result of results) {
      if (!result.accepted) rejected += 1;
      else if (result.duplicate) duplicates += 1;
      else drained += 1;
    }
  }
  fs.unlinkSync(drainingPath);
  return { drained, duplicates, rejected, malformed, droppedBytes };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_BYTES,
  drainHookSpool,
  readBoundedLines,
};
