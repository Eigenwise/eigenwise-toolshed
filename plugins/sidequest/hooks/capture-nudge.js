#!/usr/bin/env node
'use strict';

const fs = require('fs');

const MARKERS = [
  'oh and', 'oh, and', 'also ', 'also,', 'by the way', 'btw', "while you're", 'while you are',
  'one more thing', 'another thing', 'side note', 'on a side note', 'unrelated', 'separately',
  "don't forget", 'do not forget', 'note to self', 'remind me', 'remember to', 'later',
  'ticket', 'backlog', 'todo', 'to-do', 'to do', 'track this', 'add a task', 'follow up', 'follow-up',
  "doesn't work", 'does not work', "isn't working", 'is not working', 'not working', 'broken',
  'is broken', 'still broken', 'bug', ' fails', 'failing', 'throws', 'error when', 'crash',
  'regression', "doesn't send", 'does not send', 'should also', 'flaky', 'typo', 'glitch',
  'screenshot', 'this image', 'pasted', '[image', 'image-cache',
];

const MGMT_MARKERS = [
  'dashboard', 'kanban', 'quest log', 'the board', 'my board', 'show me the board',
  'open the board', 'sidequest board', 'sidequest dashboard', 'list tickets', 'list my tickets',
  'show tickets', 'show my tickets', 'my tickets', 'the tickets', 'open board', 'the sidequest',
];

const REMINDER =
  '=== sidequest === Capture a separate issue as a ticket with `ticket-filer`, then continue the current task. See the sidequest skill.';

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) || {} : {};
  } catch (_) {
    return {};
  }
}

function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

function hasMarker(text, markers) {
  const prompt = String(text || '').toLowerCase();
  return markers.some((marker) => prompt.includes(marker));
}

function hasBoardReference(text) {
  return /\bsq-\d+\b/i.test(text);
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })
  );
}

function main() {
  const data = readStdin();
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  const shouldRemind = hasMarker(prompt, MARKERS) || hasMarker(prompt, MGMT_MARKERS) || hasBoardReference(prompt);

  if (nudgeOff() && !shouldRemind) process.exit(0);
  emit(REMINDER);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
