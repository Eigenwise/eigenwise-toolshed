#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mapDocuments = require('./lib/map-documents');
const ledger = require('./lib/session-ledger');

const STOP_VETO_REASON = 'Invoke Skill codebase-mapper:update-codebase-map now. The announcement is not the update.';
const STOP_VETO_MAX_BYTES = 192;
const STATE_LOCK_WAIT_MS = 500;
const STATE_LOCK_RETRY_MS = 5;
const stateLockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) || {} : {};
  } catch (_) {
    return {};
  }
}

function projectDir(data) {
  return process.env.CLAUDE_PROJECT_DIR || (typeof data.cwd === 'string' ? data.cwd : '') || process.cwd();
}

function context(map, source, forSubagent) {
  const manifestNote = map.state.future
    ? '\nThis map uses a newer schema. Preserve its files and update the plugin before changing its metadata.\n'
    : map.state.stale
      ? '\nThe map hash manifest is stale. Treat the files on disk as authoritative and refresh the manifest after map maintenance.\n'
      : map.state.migratable
        ? '\nThis map has no hash manifest yet. Preserve the existing map and add hashes on its next update.\n'
        : '';
  // A subagent gets the map to READ. The update instruction is main-session only:
  // parallel subagents on one tree would collide on the map, and a mid-wave update
  // would describe a state that has not landed on main (SQ-1259, field-hit twice).
  const maintenance = forSubagent
    ? 'You are a subagent: NEVER update the codebase map or run update-codebase-map, even if it is reported stale. If your changes make it stale, say so in your final report; the main session refreshes the map once, after all parallel work integrates.\n'
    : 'After code changes, list modified files and assess the map. If it needs updating, announce "Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation." That announcement is not the action: invoke Skill `codebase-mapper:update-codebase-map` before ending the turn, then proceed immediately without waiting for a reply. Otherwise end with "Documentation check complete. No documentation updates needed because [reason]." Decide. Do not ask the user whether to update the map or run this skill.\n';
  return '<CODEBASE_MAP>\n' +
    'This repository has a maintained codebase map in .claude/.codebase-info/.\n\n' +
    'Before anything else in your first reply, and before starting the task, output exactly one acknowledgment line: "Codebase map: read <doc(s)>" after actually reading only relevant map document(s) from .claude/.codebase-info/, or "Codebase map: no read needed - <reason>" if the request needs no codebase knowledge. This is mandatory; do not silently skip it. Never re-read a document already read this session unless this hook names it as changed.\n\n' +
    maintenance +
    '</CODEBASE_MAP>\n\n' +
    '=== CODEBASE MAP RE-GROUNDED AFTER SESSIONSTART (' + source + ') ===\n\n' +
    '--- ' + map.index.sourcePath + ' ---\n' + map.index.content.trim() + '\n' + manifestNote;
}

function changedContext(changed, source) {
  return '[codebase-mapper] Map documents changed since last seen during SessionStart (' + source + '): ' +
    changed.map((entry) => entry.sourcePath).join(', ') +
    '. Re-read only these documents when relevant.';
}

function hookEventName(data) {
  return data.hook_event_name === 'SubagentStart' ? 'SubagentStart' : 'SessionStart';
}

function output(eventName, additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  }));
}

function stateDirectory() {
  return process.env.CODEBASE_MAPPER_STATE_DIR || path.join(os.homedir(), '.claude', 'codebase-mapper-state');
}

function sessionKey(data) {
  const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
  return sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : '';
}

function updateSkillRecord(data) {
  const key = sessionKey(data);
  return key ? path.join(stateDirectory(), 'update-skill-session-' + key) : '';
}

function recordUpdateSkill(data) {
  if (data.tool_name !== 'Skill' || data.tool_input?.skill !== 'codebase-mapper:update-codebase-map') return;
  const record = updateSkillRecord(data);
  if (!record) return;
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, 'invoked\n');
  clearStopVetoState(data);
}

function updateSkillInvoked(data) {
  const record = updateSkillRecord(data);
  if (!record || !fs.existsSync(record)) return false;
  fs.rmSync(record, { force: true });
  return true;
}

function announcement(message) {
  return /Documentation check complete\.[\s\S]{0,160}(?:run(?:ning)?|invok(?:e|ing)|start(?:ing)?|updat(?:e|ing))[\s\S]{0,80}codebase[- ]mapper(?:[:/])update[- ]codebase[- ]map/i.test(message);
}

function messageText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(messageText).join('\n');
  if (message && typeof message === 'object') return messageText(message.content || message.text || '');
  return '';
}

function stopVetoStateFile(data) {
  const key = sessionKey(data);
  return key ? path.join(stateDirectory(), 'stop-veto-' + key + '.json') : '';
}

function stopResponsibility(data) {
  return crypto.createHash('sha256').update(JSON.stringify({
    message: messageText(data.last_assistant_message),
    reason: typeof data.reason === 'string' ? data.reason : '',
  })).digest('hex');
}

function stateLockOwnerFile(lockDirectory) {
  try {
    const owners = fs.readdirSync(lockDirectory).filter((name) => name.startsWith('owner-'));
    return owners.length === 1 ? path.join(lockDirectory, owners[0]) : '';
  } catch (_) {
    return '';
  }
}

function stateLockOwnerAlive(ownerFile) {
  try {
    const owner = Number(fs.readFileSync(ownerFile, 'utf8').trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

function waitForTestGate(markerVariable, gateVariable) {
  const marker = process.env[markerVariable];
  if (marker) fs.writeFileSync(marker, `${process.pid}\n`);
  const gate = process.env[gateVariable];
  while (gate && fs.existsSync(gate)) {
    Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
  }
}

function removeStaleStateLock(lockDirectory, ownerFile) {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(lockDirectory);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireStateLock(file) {
  const lockDirectory = file + '.lock-v2';
  const generation = `${process.pid}-${crypto.randomUUID()}`;
  const ownerName = `owner-${generation}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const publishedOwnerFile = path.join(lockDirectory, ownerName);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.mkdirSync(candidateDirectory);
    fs.writeFileSync(path.join(candidateDirectory, ownerName), `${process.pid}\n`);
    while (true) {
      try {
        fs.renameSync(candidateDirectory, lockDirectory);
        waitForTestGate('CODEBASE_MAPPER_TEST_LOCK_ACQUIRED_MARKER', 'CODEBASE_MAPPER_TEST_LOCK_HOLD_GATE');
        return publishedOwnerFile;
      } catch (_) {
        const ownerFile = stateLockOwnerFile(lockDirectory);
        if (ownerFile && !stateLockOwnerAlive(ownerFile)) {
          waitForTestGate('CODEBASE_MAPPER_TEST_STALE_LOCK_MARKER', 'CODEBASE_MAPPER_TEST_STALE_LOCK_GATE');
          removeStaleStateLock(lockDirectory, ownerFile);
          const cleanedMarker = process.env.CODEBASE_MAPPER_TEST_STALE_LOCK_CLEANED_MARKER;
          if (cleanedMarker) fs.writeFileSync(cleanedMarker, `${process.pid}\n`);
          continue;
        }
        if (Date.now() >= deadline) return '';
        Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
      }
    }
  } finally {
    try {
      fs.rmSync(candidateDirectory, { recursive: true, force: true });
    } catch (_) {}
  }
}

function releaseStateLock(ownerFile) {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(path.dirname(ownerFile));
  } catch (_) {}
}

function clearStopVetoState(data) {
  const file = stopVetoStateFile(data);
  if (!file) return;
  let lockFile = '';
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return;
    fs.rmSync(file, { force: true });
  } catch (_) {
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}

function claimStopVeto(data) {
  const file = stopVetoStateFile(data);
  if (!file) return false;
  const responsibility = stopResponsibility(data);
  let lockFile = '';
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return false;
    let prior = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
    if (prior?.responsibility === responsibility) return false;
    fs.writeFileSync(file, JSON.stringify({ responsibility }) + '\n');
    return true;
  } catch (_) {
    return false;
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}

function enforceMapUpdate(data) {
  if (data.stop_hook_active === true || data.agent_id) return;
  const message = messageText(data.last_assistant_message);
  if (!announcement(message)) {
    clearStopVetoState(data);
    return;
  }
  if (updateSkillInvoked(data)) {
    clearStopVetoState(data);
    return;
  }
  if (!claimStopVeto(data)) return;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: Buffer.byteLength(STOP_VETO_REASON) <= STOP_VETO_MAX_BYTES ? STOP_VETO_REASON : STOP_VETO_REASON.slice(0, STOP_VETO_MAX_BYTES),
  }));
}

function main() {
  const data = readStdin();
  if (data.hook_event_name === 'PreToolUse') {
    recordUpdateSkill(data);
    return;
  }
  if (data.hook_event_name === 'Stop') {
    enforceMapUpdate(data);
    return;
  }
  const root = projectDir(data);
  const source = data.source || 'startup';
  const eventName = hookEventName(data);
  mapDocuments.migrateLegacyMap(root);
  const map = mapDocuments.loadMap(root);
  if (!map || !map.index) return;

  if (source === 'startup' || source === 'clear') {
    ledger.mark(root, data.session_id, map.documents, true);
    output(eventName, context(map, source, eventName === 'SubagentStart'));
    return;
  }

  if (source === 'compact') {
    output(eventName, context(map, source, eventName === 'SubagentStart'));
    return;
  }

  const changed = ledger.changed(root, data.session_id, map.documents, false);
  if (!changed.length) return;
  output(eventName, changedContext(changed, source));
}

try {
  main();
} catch (_) {
  // Hooks must never stop a session.
}
