'use strict';

const path = require('node:path');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1', '.rb', '.sql']);
const MAX_TRACKED = 400;
const MAX_SALVAGE_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024;
const TEMP_MARKERS = /(?:[\\/]|^)(?:temp|tmp|scratchpad|appdata[\\/]local[\\/]temp)(?:[\\/]|$)/i;
const BACKGROUND_STUB = /^\s*Command running in background with ID:/;

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function actorKey(actor) {
  return actor.scope === 'main' ? 'main-loop' : `subagent:${actor.agentType ?? actor.agentId}`;
}

function isEphemeral(filePath) {
  return TEMP_MARKERS.test(String(filePath ?? ''));
}

/**
 * Tracks every file written during the window, keyed by basename so the same script recreated under a
 * fresh temp directory each session still collapses into one finding.
 *
 * The last written body is kept, not regenerated later, because a rewritten script is the single
 * highest-value find in a retro: the working version already exists in the transcript. When a shell
 * command afterwards runs that file and succeeds, its recorded stdout is kept too, which turns "does
 * this salvaged script still work" into something testable instead of assumed.
 */
function createWriteDetector() {
  const byBasename = new Map();
  let dropped = 0;

  const recentWrites = [];

  const remember = (event) => {
    const filePath = event.input?.file_path ?? event.input?.notebook_path;
    if (typeof filePath !== 'string' || !filePath) return;
    const basename = path.basename(filePath);
    const isWrite = event.name === 'Write';

    let record = byBasename.get(basename);
    if (!record) {
      if (byBasename.size >= MAX_TRACKED) {
        dropped += 1;
        return;
      }
      record = {
        basename,
        extension: path.extname(basename).toLowerCase(),
        writes: 0,
        edits: 0,
        paths: new Set(),
        sessions: new Set(),
        actors: new Map(),
        ephemeral: false,
        lastContent: null,
        lastContentBytes: 0,
        lastPath: null,
        lastSessionId: null,
        proof: null,
      };
      byBasename.set(basename, record);
    }

    if (isWrite) record.writes += 1;
    else record.edits += 1;
    record.paths.add(filePath);
    record.sessions.add(event.sessionId);
    record.actors.set(actorKey(event.actor), (record.actors.get(actorKey(event.actor)) ?? 0) + 1);
    if (isEphemeral(filePath)) record.ephemeral = true;

    if (isWrite && typeof event.input?.content === 'string') {
      record.lastContent = clip(event.input.content, MAX_SALVAGE_BYTES);
      record.lastContentBytes = Buffer.byteLength(event.input.content, 'utf8');
      record.lastPath = filePath;
      record.lastSessionId = event.sessionId;
      record.proof = null;
      recentWrites.push({ basename, filePath, timestampMs: event.timestampMs });
      if (recentWrites.length > 40) recentWrites.shift();
    }
  };

  const proveByExecution = (event) => {
    const command = String(event.input?.command ?? '');
    if (!command) return;
    // A backgrounded run returns a launch stub, not the script's output. Treating that as proof would
    // give a script a passing verify it never earned, which is worse than recording no proof at all.
    if (BACKGROUND_STUB.test(String(event.text ?? ''))) return;
    for (let index = recentWrites.length - 1; index >= 0; index -= 1) {
      const candidate = recentWrites[index];
      if (!command.includes(candidate.basename)) continue;
      const record = byBasename.get(candidate.basename);
      if (!record || record.lastPath !== candidate.filePath) continue;
      record.proof = {
        tool: event.name,
        command: clip(command, 600),
        stdout: clip(event.text, MAX_STDOUT_BYTES),
        sessionId: event.sessionId,
      };
      return;
    }
  };

  return {
    name: 'writes',

    onEvent(event) {
      if (event.kind === 'tool_use' && (event.name === 'Write' || event.name === 'Edit' || event.name === 'MultiEdit' || event.name === 'NotebookEdit')) {
        remember(event);
        return;
      }
      if (event.kind === 'tool_result' && SHELL_TOOLS.has(event.name) && !event.isError) proveByExecution(event);
    },

    finish() {
      const findings = [];
      const salvage = [];

      for (const record of byBasename.values()) {
        const rewritten = record.writes >= 2 && (record.sessions.size >= 2 || record.writes >= 3);
        const scripty = SCRIPT_EXTENSIONS.has(record.extension);
        if (!rewritten) continue;

        const actors = [...record.actors].map(([label, count]) => ({ label, count }));
        const base = {
          occurrences: record.writes,
          sessions: record.sessions.size,
          actors,
          basename: record.basename,
          paths: [...record.paths].slice(0, 5),
          ephemeral: record.ephemeral,
          proven: Boolean(record.proof),
          evidence: [
            { label: 'written', text: `${record.writes} times across ${record.sessions.size} session(s)` },
            { label: 'paths', text: [...record.paths].slice(0, 3).join('\n') },
          ],
        };

        if (record.proof) {
          base.evidence.push({ label: 'proven by', text: clip(record.proof.command, 300) });
        }

        if (scripty && record.lastContent) {
          const salvageId = `salvage-${salvage.length + 1}`;
          salvage.push({
            id: salvageId,
            basename: record.basename,
            sourcePath: record.lastPath,
            sessionId: record.lastSessionId,
            bytes: record.lastContentBytes,
            truncated: record.lastContentBytes > MAX_SALVAGE_BYTES,
            content: record.lastContent,
            proof: record.proof,
          });
          findings.push({
            ...base,
            kind: 'rewritten-script',
            title: `\`${record.basename}\` was rewritten from scratch ${record.writes} times`,
            salvageId,
            salvageBytes: record.lastContentBytes,
            salvageTruncated: record.lastContentBytes > MAX_SALVAGE_BYTES,
          });
          continue;
        }

        if (record.ephemeral) {
          findings.push({
            ...base,
            kind: 'ephemeral-artifact',
            title: `\`${record.basename}\` gets rebuilt in a temp directory every session`,
          });
        }
      }

      findings.sort((a, b) => b.occurrences - a.occurrences);
      return { findings, salvage, notes: { trackedFiles: byBasename.size, droppedFiles: dropped } };
    },
  };
}

module.exports = { createWriteDetector, isEphemeral, SCRIPT_EXTENSIONS };
