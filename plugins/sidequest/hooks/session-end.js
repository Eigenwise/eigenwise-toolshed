#!/usr/bin/env node
'use strict';
/**
 * sidequest - SessionEnd hook: release this session's claims immediately
 *
 * A claim carries a TTL (default 60 min) so a crashed worker's ticket eventually
 * frees up. But when a whole SESSION ends we KNOW its claims are dead right then —
 * no reason to make a dependent ticket wait out the TTL. This hook fires on that
 * boundary, reads the ending session's id, and asks the store to release exactly
 * the claims that session took (moving each ticket back to `todo`), so the ready
 * pool recovers instantly.
 *
 * It is SAFE by construction: store.reconcileSession only touches claims the
 * worker registry attributes to THIS session id, skips anything already done or
 * re-claimed by another session, and is a no-op for an unknown/absent id. The TTL
 * stays the untouched backstop for anything the registry never saw.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output. It must never break session teardown.
 */

const path = require('path');

function readStdin() {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0);
  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) process.exit(0); // nothing to attribute claims to

  const reason = data.reason ? `session ended (${data.reason})` : 'session ended';
  let store;
  try {
    store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  } catch (_) {
    process.exit(0); // can't load the store -> the TTL still covers everything
  }
  try {
    store.reconcileSession(String(sessionId), { reason, source: 'session-end' });
  } catch (_) {
    /* best effort */
  }
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
