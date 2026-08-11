#!/usr/bin/env node
'use strict';

/**
 * SessionEnd: tally this one session's friction (denials, interrupts, corrections, errors) into
 * the project's state file. Cheap by design: one streamed pass over the transcript that just
 * ended, no LLM, no network, nothing injected. The resupply skill and the SessionStart nudge read
 * these tallies later.
 */

const fs = require('node:fs');

const { recordSessionTally } = require('../lib/state.js');
const { tallyTranscript } = require('../lib/mine.js');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function main() {
  const data = readStdin();
  const transcriptPath = data.transcript_path;
  const sessionId = data.session_id;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd;
  if (!transcriptPath || !sessionId || !projectDir) return;
  if (!fs.existsSync(transcriptPath)) return;

  const tally = await tallyTranscript(transcriptPath, sessionId);
  recordSessionTally(projectDir, sessionId, tally);
}

main().catch(() => {}).finally(() => process.exit(0));
