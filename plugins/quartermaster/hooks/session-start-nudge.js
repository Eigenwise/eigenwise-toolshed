#!/usr/bin/env node
'use strict';

/**
 * SessionStart: put the capability-capture charter in front of every session, and tell Claude to
 * offer a resupply pass when one is due. This hook never analyzes anything itself. Continuous
 * background analysis is the documented failure mode of this plugin category (piles of suggestions
 * nobody triages), so deep analysis only starts after the user accepts a bounded optimization round,
 * and every recommendation that pass surfaces still needs the user's per-item approval before anything
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
const CAPABILITY_CHARTER = 'quartermaster: while you work, watch for capability gaps worth capturing in the moment. A multi-step task you have now done by hand more than once should become a skill; knowledge you re-derived belongs in the codebase map or CLAUDE.md; a convention you had to be told becomes a rule; a claim nobody can check deserves a committed measurement. When you notice one, say so and offer to capture it right then. If nothing was missing, stay silent. At a natural pause after substantial work, proactively ask whether the user wants a focused optimization round for their development system, setup, tooling, or workflow. Run the quartermaster resupply skill after they say yes, or automatically when they have explicitly given standing permission for these rounds. It proposes each change separately and applies nothing without approval unless the user has also explicitly pre-approved that exact class of change.';

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
    return `quartermaster is newly installed and found ${recent} recent sessions for this project. Once the user's current ask is handled, proactively ask whether they want a focused optimization round for their development system, setup, tooling, or workflow. Run the quartermaster resupply skill after they say yes, or automatically if they have explicitly given standing permission for these rounds. It proposes one recommendation at a time, and nothing changes without approval unless their standing permission also covers that exact class of change.`;
  }

  const status = statusFor(projectDir);
  if (!status.shouldNudge) return null;
  markNudged(projectDir);
  return `quartermaster: ${status.unanalyzedSessions} sessions since the last resupply, with ${status.frictionEvents} friction events recorded (permission denials, interrupts, corrections). At the first natural pause, proactively ask whether the user wants a focused optimization round for their development system, setup, tooling, or workflow. Run the quartermaster resupply skill after they say yes, or automatically if they have explicitly given standing permission for these rounds. Nothing has been analyzed yet, and each recommendation still needs separate approval unless their standing permission also covers that exact class of change.`;
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
