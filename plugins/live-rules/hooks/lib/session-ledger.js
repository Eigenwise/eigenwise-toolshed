'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stateRoot() {
  return process.env.LIVE_RULES_STATE_DIR || path.join(os.homedir(), '.claude', 'live-rules-state');
}

function ledgerPath(projectDir, sessionId) {
  return path.join(stateRoot(), digest(path.resolve(projectDir)), digest(sessionId) + '.json');
}

function cleanup(root) {
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(dir, file.name);
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
    const temp = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ seen: ledger.seen, updatedAt: new Date().toISOString() }) + '\n');
    fs.renameSync(temp, target);
  } catch (_) {
    // A missing ledger only causes a later re-grounding.
  }
}

function changed(projectDir, sessionId, selected, reset) {
  const ledger = read(projectDir, sessionId);
  if (!ledger) return selected;
  if (reset) ledger.seen = {};
  const fresh = selected.filter((entry) => ledger.seen[entry.rule.sourcePath] !== entry.rule.hash);
  for (const entry of fresh) ledger.seen[entry.rule.sourcePath] = entry.rule.hash;
  write(projectDir, sessionId, ledger);
  return fresh;
}

module.exports = { changed, ledgerPath, stateRoot };
