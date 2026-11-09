'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stateRoot } = require('./paths.js');
const { MIN_APPROVALS, applyLearnedPermissionAllowlist, learnPermissionAllowlist } = require('./permission-allowlist.js');

function learningCacheFile(projectPath, environment = process.env) {
  const identity = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex');
  return path.join(stateRoot(environment), 'allowlist-learning', `${identity}.json`);
}

function validCandidate(entry) {
  return typeof entry?.fingerprint === 'string'
    && entry.fingerprint.startsWith('permission:')
    && Number.isInteger(entry.approvals)
    && entry.approvals >= MIN_APPROVALS;
}

function validLearningCache(learning, projectPath) {
  return learning.projectPath === path.resolve(projectPath)
    && Array.isArray(learning.candidates)
    && learning.candidates.every(validCandidate)
    && Array.isArray(learning.window?.files);
}

function readLearningCache(projectPath, environment = process.env) {
  try {
    const learning = JSON.parse(fs.readFileSync(learningCacheFile(projectPath, environment), 'utf8'));
    return validLearningCache(learning, projectPath) ? learning : null;
  } catch {
    return null;
  }
}

async function refreshLearningCache(projectPath, environment = process.env) {
  const learning = await learnPermissionAllowlist({ projectPath, env: environment });
  const destination = learningCacheFile(projectPath, environment);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...learning, projectPath: path.resolve(projectPath) }));
  fs.renameSync(temporary, destination);
}

function applyLearningCache(projectPath, environment = process.env) {
  const learning = readLearningCache(projectPath, environment);
  if (!learning) return null;
  const result = applyLearnedPermissionAllowlist(learning, { projectPath, env: environment });
  fs.unlinkSync(learningCacheFile(projectPath, environment));
  return result;
}

module.exports = { applyLearningCache, learningCacheFile, readLearningCache, refreshLearningCache, validCandidate };
