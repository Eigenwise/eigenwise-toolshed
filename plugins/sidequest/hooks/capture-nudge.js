#!/usr/bin/env node
'use strict';
/**
 * sidequest - UserPromptSubmit hook: "capture the side quest"
 *
 * The whole point of sidequest is that a stray issue you mention while Claude is
 * mid-task ("oh, and the contact form doesn't send") gets turned into a ticket
 * on the spot, instead of being lost the moment the conversation moves on.
 *
 * A hook can't understand the prompt, so it doesn't try to decide *what* the
 * ticket is. Instead, when the prompt looks like it might carry a side issue (or
 * a pasted image), it injects a short, standing instruction telling Claude to:
 *   - capture that issue as a ticket immediately, WITHOUT derailing the task it
 *     is already working on, and
 *   - attach any pasted image by its file path.
 * It hands Claude the exact command and any image paths it can find, so filing
 * is one quick step. The decision to file stays with Claude (the instruction is
 * conditional), so an ordinary prompt about the current task creates no ticket.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output. It must never break a prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) || {} : {};
  } catch (_) {
    return {};
  }
}

// Phrases that suggest the message is raising something to track, rather than
// only continuing the current task. Deliberately broad: a false positive just
// injects a short reminder that Claude may ignore; the real guard is that the
// instruction only asks Claude to file a ticket for a *separate* issue.
const MARKERS = [
  // interjections
  'oh and', 'oh, and', 'also ', 'also,', 'by the way', 'btw', "while you're", 'while you are',
  'one more thing', 'another thing', 'side note', 'on a side note', 'unrelated', 'separately',
  "don't forget", 'do not forget', 'note to self', 'remind me', 'remember to', 'later',
  // explicit ticketing
  'ticket', 'backlog', 'todo', 'to-do', 'to do', 'track this', 'add a task', 'follow up', 'follow-up',
  // defect language
  "doesn't work", 'does not work', "isn't working", 'is not working', 'not working', 'broken',
  'is broken', 'still broken', 'bug', ' fails', 'failing', 'throws', 'error when', 'crash',
  'regression', "doesn't send", 'does not send', 'should also',
  'flaky', 'typo', 'glitch',
  // NOTE: 'needs to' / 'missing' / "won't" were removed — they trip on ordinary task
  // descriptions ("the parser needs to handle X", "the config is missing a field"),
  // not just side issues, so they over-fired capture. Keep this list to genuine
  // side-issue / defect signals.
  // image cues
  'screenshot', 'this image', 'pasted', '[image', 'image-cache',
];

function looksLikeSideIssue(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  for (const m of MARKERS) {
    if (t.indexOf(m) !== -1) return true;
  }
  return false;
}

// Phrases about viewing or managing the board itself (as opposed to raising a
// new issue). When these match, we inject the CLI path plus ready-to-run board
// commands, so "show me the dashboard" or "close SQ-3" just works.
const MGMT_MARKERS = [
  'dashboard', 'kanban', 'quest log', 'the board', 'my board', 'show me the board',
  'open the board', 'sidequest board', 'sidequest dashboard', 'list tickets', 'list my tickets',
  'show tickets', 'show my tickets', 'my tickets', 'the tickets', 'open board', 'the sidequest',
];

function looksLikeBoardManagement(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/\bsq-\d+\b/i.test(t)) return true; // "close SQ-3", "move SQ-2 to done"
  for (const m of MGMT_MARKERS) {
    if (t.indexOf(m) !== -1) return true;
  }
  return false;
}

// A "strong" capture signal is a new problem being raised (bug/interjection/
// image) — not the bare word "ticket", which is ambiguous ("make a ticket" vs
// "list tickets"). Used only to decide capture-vs-management precedence.
const STRONG_CAPTURE_MARKERS = [
  'oh and', 'oh, and', 'also ', 'also,', 'by the way', 'btw', "while you're", 'while you are',
  'one more thing', 'another thing', 'side note', 'on a side note', 'unrelated', 'separately',
  "don't forget", 'do not forget', 'note to self', 'remind me', 'remember to',
  "doesn't work", 'does not work', "isn't working", 'is not working', 'not working', 'broken',
  'is broken', 'still broken', 'bug', ' fails', 'failing', 'throws', 'error when', 'crash',
  'regression', "doesn't send", 'does not send', 'should also', 'flaky', 'typo', 'glitch',
];

function hasStrongCapture(text) {
  const t = String(text || '').toLowerCase();
  for (const m of STRONG_CAPTURE_MARKERS) {
    if (t.indexOf(m) !== -1) return true;
  }
  return false;
}

// Pull any pasted-image file paths out of the prompt so we can hand them to
// Claude explicitly. Claude Code stores pasted images under ~/.claude/image-cache.
function findImagePaths(text) {
  const found = new Set();
  const src = String(text || '');
  const patterns = [
    /source:\s*([^\]\r\n]+\.(?:png|jpe?g|gif|webp|bmp))/gi, // "[Image: source: PATH]"
    /([A-Za-z]:\\[^\s"'\]]*image-cache[^\s"'\]]*\.(?:png|jpe?g|gif|webp|bmp))/gi, // Windows path
    /((?:\/[^\s"'\]]*)?image-cache\/[^\s"'\]]*\.(?:png|jpe?g|gif|webp|bmp))/gi, // POSIX path
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1].trim());
  }
  return Array.from(found);
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

// The small always-on reminder can be turned off with SIDEQUEST_NUDGE=off for
// anyone who finds a per-prompt nudge too chatty (the marker-triggered capture
// and board-control blocks still fire).
function nudgeOff() {
  const v = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })
  );
}

// A compact restatement of the plan + fan-out discipline. The full standing
// reminder only fires on prompts with no capture/board-mgmt marker — but the
// prompts that KICK OFF real multi-part work are the ones most likely to trip a
// defect/interjection marker ("fix the broken X, also wire up Y"), which used to
// swap in the capture or board-control block and drop the fan-out guidance
// entirely. So we append this footer to those blocks too: the specific block
// still leads, but the discipline is never fully suppressed.
function coreDisciplineFooter() {
  return (
    '\n\n— sidequest discipline still applies: plan multi-part work as tickets first, and fan out ' +
    'independent work (a parallel Explore / code-explorer scout before you read ~4+ files; independent ' +
    'ready tickets as parallel executors) rather than grinding serially.'
  );
}

function main() {
  const data = readStdin();
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  const sessionId = data.session_id || data.sessionId || '';

  const images = findImagePaths(prompt);
  const mentionsImage = images.length > 0 || /\[image|screenshot|pasted|image-cache/i.test(prompt);
  const isCapture = looksLikeSideIssue(prompt) || mentionsImage;
  const isMgmt = looksLikeBoardManagement(prompt);
  const strongCapture = mentionsImage || hasStrongCapture(prompt);

  const cli = `node "${path.join(pluginRoot(), 'bin', 'sidequest.js')}"`;

  // No capture/board signal in this message: keep a short standing reminder in
  // front of Claude (unless opted out) so it actually uses sidequest rather than
  // forgetting the system is here. The heavier blocks below fire on a match.
  if (!isCapture && !isMgmt) {
    if (nudgeOff()) process.exit(0);
    emit(
      '=== sidequest (active) ===\n' +
        'Track work on the board; don\'t keep the plan only in your head.\n' +
        'Even if this repo uses an external tracker (Jira/Linear/GitHub Issues), that tracks the ' +
        'deliverable — sidequest is still your LOCAL execution layer here (decompose, fan out, run ' +
        'subagents). Use it anyway; don\'t skip it because the work is "already tracked". See the sidequest ' +
        'skill for why/how the two coexist.\n' +
        '• CAPTURE a bug/task/idea SEPARATE from your current work as a ticket right away (bg `ticket-filer` ' +
        'agent, or `' + cli + ' add`).\n' +
        '• PLAN substantial/multi-part work as one ticket per piece FIRST, link deps, then work them ' +
        '(claim → do → `done`) — not ad hoc.\n' +
        '• FAN OUT: about to read ~4+ files or grep a subsystem to understand it? Spawn a parallel ' +
        'Explore / code-explorer scout FIRST. Run independent ready tickets as parallel executors (claim ' +
        'first, distinct `--by`). Keep dependent/same-file work serial.\n' +
        '• RECORD an investigation as a ticket and write findings back as a comment (`' + cli +
        ' comment <ref>`); READ a ticket\'s comments before working it.\n' +
        'Board: `' + cli + ' dashboard`.'
    );
    process.exit(0);
  }

  // Board management (e.g. "show me the dashboard", "list my tickets", "close
  // SQ-3"): give Claude the resolved CLI path and the exact commands. Capture
  // wins only when a *new* issue is clearly present (bug/interjection/image).
  if (isMgmt && !strongCapture) {
    emit(
      '=== sidequest — board control ===\n' +
        'Use the sidequest CLI to view or manage the board (absolute path resolved for you). ' +
        'Run these with the Bash tool:\n' +
        `  Open the live board in the browser:  ${cli} dashboard\n` +
        `  List tickets on this project:        ${cli} list\n` +
        `  Move / edit a ticket:                ${cli} update SQ-3 --status done   (status: todo|doing|done; also -p, -t, -d, -l)\n` +
        `  Remove a ticket:                     ${cli} rm SQ-3\n` +
        `  List every project's board:          ${cli} projects\n` +
        '\nTo WORK a ticket safely (other agents may share this board): claim it FIRST, then work, then finish.\n' +
        `  ${cli} claim SQ-3 --by <you>   (or ${cli} next --by <you> to grab the top-priority ticket)\n` +
        `  ${cli} done SQ-3 --by <you>    when finished  ·  ${cli} release SQ-3 --by <you>  to drop it\n` +
        'Claiming is atomic: if it fails (already claimed / done / gone) do NOT work the ticket — pick another. ' +
        'For a small ticket you may spawn a subagent to do the work, but only AFTER the claim succeeds.\n' +
        'Tickets are stored centrally, so `dashboard` shows every project at once. To open the board, ' +
        'just run the dashboard command — it starts the local server if needed and opens the browser, ' +
        'then report the URL it prints.' +
        coreDisciplineFooter()
    );
    process.exit(0);
  }

  let imageHint = '';
  if (images.length) {
    imageHint =
      '\nPasted image(s) detected — attach each with -i (or pass to the subagent):\n' +
      images.map((p) => `  ${p}`).join('\n') + '\n';
  } else if (mentionsImage) {
    const dir = sessionId
      ? path.join(os.homedir(), '.claude', 'image-cache', String(sessionId))
      : path.join(os.homedir(), '.claude', 'image-cache', '<session>');
    imageHint =
      `\nAn image seems to be attached. Attach it with -i using the source path shown in the conversation (they live under ${dir}).\n`;
  }

  const context =
    '=== sidequest — capture the side quest ===\n' +
    'If this message raised an issue, bug, or task SEPARATE from what you are currently doing, ' +
    'capture it as a ticket right now so it is not lost, then carry on with your current task ' +
    'without derailing it. (If the message is only about the task you are already on, ignore this.)\n' +
    '\n' +
    'Preferred: spawn the `ticket-filer` subagent in the BACKGROUND (run_in_background: true) so your ' +
    'current work is not interrupted. Give it a short title, a one-line description, a priority ' +
    '(low|normal|high|urgent), any labels, and any pasted image path.\n' +
    '\n' +
    'Or file it directly in one command:\n' +
    `  ${cli} add -t "Short title" -d "What is wrong" -p high -l bug --complexity <1-10> --why "<motivation>"` +
    (images.length ? ` -i "${images[0]}"` : '') +
    '\n' +
    '  (both required — score 1-10 by real task complexity and motivate it in one concrete sentence; routing is derived)\n' +
    imageHint +
    'Do NOT ask permission first and do NOT stop your current task to do this — capture, then continue. ' +
    'Say one short line noting the ticket ref (e.g. "filed SQ-5") when done.' +
    coreDisciplineFooter();

  emit(context);
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
