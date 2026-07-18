#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function context(map, source) {
  const manifestNote = map.state.future
    ? '\nThis map uses a newer schema. Preserve its files and update the plugin before changing its metadata.\n'
    : map.state.stale
      ? '\nThe map hash manifest is stale. Treat the files on disk as authoritative and refresh the manifest after map maintenance.\n'
      : map.state.migratable
        ? '\nThis map has no hash manifest yet. Preserve the existing map and add hashes on its next update.\n'
        : '';
  return '<MANDATORY_INSTRUCTION>\n' +
    'This repository has a maintained codebase map in .claude/.codebase-info/.\n\n' +
    'Read only map document(s) relevant to the current request. If the request does not require codebase knowledge, state that no map read is needed. Never re-read a document already read this session unless this hook names it as changed.\n\n' +
    'After code changes, list modified files, assess whether the map needs an update, and end with either "Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation." or "Documentation check complete. No documentation updates needed because [reason]."\n' +
    '</MANDATORY_INSTRUCTION>\n\n' +
    '=== CODEBASE MAP RE-GROUNDED AFTER SESSIONSTART (' + source + ') ===\n\n' +
    '--- ' + map.index.sourcePath + ' ---\n' + map.index.content.trim() + '\n' + manifestNote;
}

function changedContext(changed, source) {
  return '[codebase-mapper] Map documents changed since last seen during SessionStart (' + source + '): ' +
    changed.map((entry) => entry.sourcePath).join(', ') +
    '. Re-read only these documents when relevant.';
}

function main() {
  const data = readStdin();
  const root = projectDir(data);
  const source = data.source || 'startup';
  mapDocuments.migrateLegacyMap(root);
  const map = mapDocuments.loadMap(root);
  if (!map || !map.index) return;

  if (source === 'startup' || source === 'clear') {
    ledger.mark(root, data.session_id, map.documents, true);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context(map, source),
      },
    }));
    return;
  }

  if (source === 'compact') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context(map, source),
      },
    }));
    return;
  }

  const changed = ledger.changed(root, data.session_id, map.documents, false);
  if (!changed.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: changedContext(changed, source),
    },
  }));
}

try {
  main();
} catch (_) {
  // Hooks must never stop a session.
}
