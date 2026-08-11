#!/usr/bin/env node
'use strict';

/**
 * SessionStart: decide whether a resupply pass is worth suggesting, and say so in one line if it
 * is. This hook never analyzes anything itself. Continuous background analysis is the documented
 * failure mode of this plugin category (piles of suggestions nobody triages), so all real work
 * waits until the user opts in by running the resupply skill.
 */

const fs = require('node:fs');

const { countRecentTranscripts } = require('../lib/scan.js');
const { markNudged, readProjectState, statusFor } = require('../lib/state.js');

const FIRST_RUN_MIN_TRANSCRIPTS = 5;

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

function main() {
  const data = readStdin();
  if (data.source && data.source !== 'startup') return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();

  const state = readProjectState(projectDir);
  if (!state.sessions.length && !state.lastResupplyAt) {
    // Freshly installed: no tallies yet, but past transcripts may already be worth a first look.
    if (state.lastNudgeAt) return;
    const recent = countRecentTranscripts(projectDir, 14);
    if (recent < FIRST_RUN_MIN_TRANSCRIPTS) return;
    markNudged(projectDir);
    emit(`quartermaster is newly installed and found ${recent} recent sessions for this project. When convenient, suggest running the quartermaster resupply skill for a first pass: it mines those transcripts for what would make the user's current work easier, and every recommendation needs their approval. Do not run it unprompted; mention it once and move on.`);
    return;
  }

  const status = statusFor(projectDir);
  if (!status.shouldNudge) return;
  markNudged(projectDir);
  emit(`quartermaster: ${status.unanalyzedSessions} sessions since the last resupply, with ${status.frictionEvents} friction events recorded (permission denials, interrupts, corrections). When a natural pause comes, suggest running the quartermaster resupply skill to look at what would make the current work easier. Nothing has been analyzed or changed; mention it once and move on.`);
}

try {
  main();
} catch {
  process.exit(0);
}
