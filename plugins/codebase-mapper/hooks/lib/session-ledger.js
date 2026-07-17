'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stateRoot() {
  return process.env.CODEBASE_MAPPER_STATE_DIR || path.join(os.homedir(), '.claude', 'codebase-mapper-state');
}

function ledgerPath(projectDir, sessionId) {
  return path.join(stateRoot(), digest(path.resolve(projectDir)), digest(sessionId) + '.json');
}

function cleanup(root) {
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const directory = path.join(root, project.name);
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(directory, file.name);
        if (Date.now() - fs.statSync(target).mtimeMs > MAX_AGE_MS) fs.unlinkSync(target);
      }
    }
  } catch (_) {
    // State is an optimization. A failed cleanup must never affect a hook.
  }
}

function read(projectDir, sessionId) {
  if (!sessionId) return null;
  const root = stateRoot();
  cleanup(root);
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(projectDir, sessionId), 'utf8'));
    return parsed && typeof parsed.seen === 'object' ? parsed : { seen: {} };
  } catch (_) {
    return { seen: {} };
  }
}

function write(projectDir, sessionId, ledger) {
  if (!sessionId) return;
  try {
    const target = ledgerPath(projectDir, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ seen: ledger.seen, updatedAt: new Date().toISOString() }) + '\n');
    fs.renameSync(temporary, target);
  } catch (_) {
    // A missing ledger only causes a later re-grounding.
  }
}

function changed(projectDir, sessionId, selected, reset) {
  const ledger = read(projectDir, sessionId);
  if (!ledger) return selected;
  if (reset) ledger.seen = {};
  const fresh = selected.filter((entry) => ledger.seen[entry.sourcePath] !== entry.hash);
  for (const entry of fresh) ledger.seen[entry.sourcePath] = entry.hash;
  write(projectDir, sessionId, ledger);
  return fresh;
}

function mark(projectDir, sessionId, selected, reset) {
  const ledger = read(projectDir, sessionId);
  if (!ledger) return;
  if (reset) ledger.seen = {};
  for (const entry of selected) ledger.seen[entry.sourcePath] = entry.hash;
  write(projectDir, sessionId, ledger);
}

module.exports = { changed, ledgerPath, mark, stateRoot };
