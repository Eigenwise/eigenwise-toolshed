#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const mapDocuments = require('./lib/map-documents');
const ledger = require('./lib/session-ledger');

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

function context(changed, state) {
  const paths = changed.map((entry) => entry.sourcePath);
  const manifestNote = state.stale
    ? ' The hash manifest is stale, so the files on disk were used as the source of truth.'
    : state.migratable
      ? ' This legacy map has no hash manifest yet; add one on its next map update.'
      : '';
  return '[codebase-mapper] Map document update detected. Re-read exactly: ' + paths.join(', ') + '.' + manifestNote;
}

function main() {
  const data = readStdin();
  const root = projectDir(data);
  const map = mapDocuments.loadMap(root);
  if (!map) return;
  const changed = ledger.changed(root, data.session_id, map.documents, false);
  if (!changed.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context(changed, map.state),
    },
  }));
}

try {
  main();
} catch (_) {
  // Hooks must never stop a prompt.
}
