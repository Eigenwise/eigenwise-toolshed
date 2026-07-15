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
 * Token diet (2026-07): every block this hook emits lands as UNCACHED context on
 * the turn it fires and then sits in the transcript for the rest of the session,
 * so per-prompt output is the single most expensive surface the plugin has. The
 * no-marker standing reminder is therefore one short line (the full doctrine
 * lives in the SessionStart hook, which re-fires on compact/resume, and in the
 * skill), and the marker-gated blocks are kept tight. Don't grow them back:
 * hooks.test.js enforces byte budgets on each block.
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

// One short line restating the execution discipline, appended to the
// marker-gated blocks so an action prompt that trips capture/board-control
// doesn't lose it entirely. Deliberately tiny — the full version lives in the
// SessionStart hook and the skill.
function disciplineFooter() {
  return (
    '\n— sidequest: classify tickets from the live taxonomy and stamp an unlabeled ticket before claim; ' +
    'spawn each ticket\'s `exec.agent` with ' +
    '`model: exec.model` (required on Claude routes, omit on Codex) as short, bounded executor runs; ' +
    'batch small same-model tickets, parallelize independent ones. Delegate substantial or parallel work; ' +
    'inline only trivial one-steps, never big work pulled inline to save wakeups.'
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

  // No capture/board signal in this message: one short standing line (unless
  // opted out) so the board isn't forgotten mid-session. The full doctrine is
  // NOT repeated here — SessionStart injects it once per session (and again on
  // compact/resume), and the sidequest skill carries the details.
  if (!isCapture && !isMgmt) {
    if (nudgeOff()) process.exit(0);
    emit(
      '=== sidequest (active) === Plan multi-part work as tickets on the board; capture side issues as ' +
        'tickets (background `ticket-filer`). Category routing chooses the executor from live board reads; ' +
        'classify and stamp an unlabeled ticket before claim. See the sidequest skill.'
    );
    process.exit(0);
  }

  // Board management (e.g. "show me the dashboard", "list my tickets", "close
  // SQ-3"): give Claude the resolved CLI path and the exact commands. Capture
  // wins only when a *new* issue is clearly present (bug/interjection/image).
  if (isMgmt && !strongCapture) {
    emit(
      '=== sidequest — board control ===\n' +
        'Board actions go through the MCP tools when they are in your toolset: ' +
        'mcp__plugin_sidequest_board__list / add / update / claim / next / done / release / comment / ' +
        'ask / comments / link / models / projects (same fields as the CLI flags). Using Bash for a ' +
        'board action when those tools are present is the wrong call — more prompts, shell-quoting ' +
        'traps.\n' +
        'The CLI (Bash, path already resolved) is the fallback, and the ONLY route to the dashboard:\n' +
        `  ${cli} dashboard    — open the live board; report the URL it prints\n` +
        `  ${cli} list --brief · update SQ-3 --status done · rm SQ-3\n` +
        'To WORK a ticket, claim it FIRST (claim/next with a unique --by), then work, then done ' +
        '(release to drop it). Claiming is atomic — if it fails, do NOT work that ticket; pick another.' +
        disciplineFooter()
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
    'If this message raised an issue/task SEPARATE from what you are currently doing, capture it as a ' +
    'ticket right now, then carry on without derailing. (If it is only about the current task, ignore ' +
    'this.)\n' +
    'Preferred: spawn the `ticket-filer` subagent in the BACKGROUND (run_in_background: true) with a short ' +
    'title, a one-line description, a category selected from the live taxonomy, a priority, any labels, and any pasted image path. Or file directly: ' +
    'mcp__plugin_sidequest_board__add when available, else\n' +
    `  ${cli} add -t "Short title" -d "What is wrong" -p high -l bug --category <id> (legacy: --complexity <1-10> --why "<motivation>")` +
    (images.length ? ` -i "${images[0]}"` : '') +
    '\n' +
    imageHint +
    'Do NOT ask permission and do NOT stop your current task — capture, then continue; note the ref ' +
    '(e.g. "filed SQ-5") in one short line.' +
    disciplineFooter();

  emit(context);
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
