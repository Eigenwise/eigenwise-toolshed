#!/usr/bin/env node
'use strict';

/**
 * SessionStart: put the capability-capture charter in front of every session, and tell Claude to
 * run a resupply pass when one is due. This hook never analyzes anything itself. Continuous
 * background analysis is the documented failure mode of this plugin category (piles of suggestions
 * nobody triages), so deep analysis only starts on a bounded cadence (thresholds + cooldown) and
 * every recommendation a pass surfaces still needs the user's per-item approval before anything
 * changes.
 */

const fs = require('node:fs');
const path = require('node:path');

const { countRecentTranscripts } = require('../lib/scan.js');
const { markNudged, readProjectState, statusFor } = require('../lib/state.js');

const FIRST_RUN_MIN_TRANSCRIPTS = 5;

// The in-the-moment half of the loop: recognizing mid-session that the thing being done for the
// third time should become a skill, a map entry, a rule, or a measurement. The setup skill seeds a
// stronger per-prompt live rule for this; the charter covers every project that never ran setup.
const CAPABILITY_CHARTER = 'quartermaster: while you work, watch for capability gaps worth capturing in the moment. A multi-step task you have now done by hand more than once should become a skill; knowledge you re-derived belongs in the codebase map or CLAUDE.md; a convention you had to be told becomes a rule; a claim nobody can check deserves a committed measurement. When you notice one, say so and offer to capture it right then. If nothing was missing, stay silent. For a deeper pass over recent sessions, run the quartermaster resupply skill.';

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

function seededSelfImprovementRuleExists(projectDir) {
  return fs.existsSync(path.join(projectDir, '.claude', 'live-rules', 'rules', 'self-improvement.md'));
}

function resupplyNudge(projectDir) {
  const state = readProjectState(projectDir);
  if (!state.sessions.length && !state.lastResupplyAt) {
    // Freshly installed: no tallies yet, but past transcripts may already be worth a first look.
    if (state.lastNudgeAt) return null;
    const recent = countRecentTranscripts(projectDir, 14);
    if (recent < FIRST_RUN_MIN_TRANSCRIPTS) return null;
    markNudged(projectDir);
    return `quartermaster is newly installed and found ${recent} recent sessions for this project. Once the user's current ask is handled, run the quartermaster resupply skill for a first pass without waiting to be asked: it mines those transcripts for what would make the user's current work easier, and every recommendation still needs their per-item approval before anything changes.`;
  }

  const status = statusFor(projectDir);
  if (!status.shouldNudge) return null;
  markNudged(projectDir);
  return `quartermaster: ${status.unanalyzedSessions} sessions since the last resupply, with ${status.frictionEvents} friction events recorded (permission denials, interrupts, corrections). At the first natural pause, run the quartermaster resupply skill without waiting to be asked, to look at what would make the current work easier. Nothing has been analyzed yet, and every recommendation the pass surfaces still needs the user's per-item approval before anything changes.`;
}

function main() {
  const data = readStdin();
  if (data.source && data.source !== 'startup') return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();

  const parts = [];
  if (!seededSelfImprovementRuleExists(projectDir)) parts.push(CAPABILITY_CHARTER);
  const nudge = resupplyNudge(projectDir);
  if (nudge) parts.push(nudge);
  if (parts.length) emit(parts.join('\n\n'));
}

try {
  main();
} catch {
  process.exit(0);
}
