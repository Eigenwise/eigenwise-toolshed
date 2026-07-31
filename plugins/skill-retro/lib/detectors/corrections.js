'use strict';

const MAX_CORRECTIONS = 40;
const QUOTE_CHARS = 400;

// Openers that mean the previous turn went the wrong way. Matched at the start of the prompt, where a
// correction almost always lands, so an incidental "actually" mid-paragraph does not trip it.
const OPENERS = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|actually\b|not (?:like )?that\b|that'?s not\b|revert\b|undo\b|never\b|please (?:don'?t|stop)\b)/i;
const PHRASES = /\b(?:i (?:already )?(?:told|said|asked)|you keep|again,|why did you|i didn'?t ask|that'?s wrong|not what i)\b/i;

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function themeOf(text) {
  const value = String(text).toLowerCase();
  // Inflected forms are matched deliberately: "stop pushing to main" is the same lesson as "do not
  // push", and a theme that only catches the bare stem splits one recurring correction into singletons
  // that then get dropped as one-offs.
  const themes = [
    ['commit/git', /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|branch(?:es|ed|ing)?|merg(?:e|es|ed|ing)|rebas(?:e|es|ed|ing)|stag(?:e|es|ed|ing)|git)\b/],
    ['delegation', /\b(?:delegat(?:e|es|ed|ing)|dispatch(?:es|ed|ing)?|executors?|tickets?|inline|subagents?|yourself)\b/],
    ['scope', /\b(?:scope[ds]?|only|just|don'?t touch|out of scope|stay in)\b/],
    ['style/voice', /\b(?:em dash(?:es)?|voice|tone|wording|phrasing|style|comments?)\b/],
    ['tooling', /\b(?:powershell|bash|scripts?|hooks?|plugins?|skills?)\b/],
    ['verification', /\b(?:tests?|verif(?:y|ied|ies)|check(?:s|ed)?|prov(?:e|ed|en)|run it)\b/],
  ];
  for (const [name, pattern] of themes) if (pattern.test(value)) return name;
  return 'general';
}

/**
 * Collects the moments the user pushed back, with the action that provoked them.
 *
 * A correction is never turned into a skill: skills are invoked when someone opts in, and a habit that
 * needs correcting is exactly the case where nobody thinks to opt in. It belongs in a live rule or a
 * memory entry, where it arrives unbidden. The verbatim wording is kept because the reason a
 * correction was given is the part that stops it recurring, and a paraphrase loses it.
 */
function createCorrectionDetector() {
  const corrections = [];
  const denials = [];
  let lastAction = null;

  return {
    name: 'corrections',

    onEvent(event) {
      if (event.kind === 'tool_use') {
        lastAction = { name: event.name, target: event.input?.file_path ?? event.input?.command ?? null };
        return;
      }

      if (event.kind === 'tool_result' && event.denial) {
        if (denials.length < MAX_CORRECTIONS) {
          denials.push({
            tool: event.name,
            kind: event.denial,
            target: clip(event.input?.file_path ?? event.input?.command ?? '', 160),
            sessionId: event.sessionId,
            actor: event.actor.scope === 'main' ? 'main-loop' : `subagent:${event.actor.agentType ?? event.actor.agentId}`,
          });
        }
        return;
      }

      if (event.kind !== 'user_prompt') return;
      const text = String(event.text ?? '');
      if (!OPENERS.test(text) && !PHRASES.test(text)) return;
      if (corrections.length >= MAX_CORRECTIONS) return;

      corrections.push({
        quote: clip(text, QUOTE_CHARS),
        theme: themeOf(text),
        after: lastAction ? `${lastAction.name}${lastAction.target ? ` ${clip(lastAction.target, 120)}` : ''}` : null,
        sessionId: event.sessionId,
      });
    },

    finish() {
      const byTheme = new Map();
      for (const correction of corrections) {
        const entry = byTheme.get(correction.theme) ?? { theme: correction.theme, items: [], sessions: new Set() };
        entry.items.push(correction);
        entry.sessions.add(correction.sessionId);
        byTheme.set(correction.theme, entry);
      }

      const findings = [...byTheme.values()]
        // A single correction that resists classification is usually situational. Reporting it anyway
        // is the padding that teaches the reader to skim the whole report.
        .filter((entry) => entry.items.length > 1 || entry.theme !== 'general')
        .sort((a, b) => b.items.length - a.items.length)
        .map((entry) => ({
          kind: 'user-correction',
          theme: entry.theme,
          title: entry.items.length > 1
            ? `Corrected ${entry.items.length} times about ${entry.theme}`
            : `Correction about ${entry.theme}`,
          occurrences: entry.items.length,
          sessions: entry.sessions.size,
          actors: [{ label: 'user', count: entry.items.length }],
          evidence: entry.items.slice(0, 4).map((item) => ({
            label: item.after ? `after ${item.after}` : 'said',
            text: item.quote,
          })),
        }));

      if (denials.length >= 2) {
        const byTool = new Map();
        for (const denial of denials) byTool.set(denial.tool, (byTool.get(denial.tool) ?? 0) + 1);
        findings.push({
          kind: 'permission-denial',
          title: `${denials.length} tool calls were denied`,
          occurrences: denials.length,
          sessions: new Set(denials.map((denial) => denial.sessionId)).size,
          actors: [...new Set(denials.map((denial) => denial.actor))].map((label) => ({ label, count: 1 })),
          evidence: [
            { label: 'denied tools', text: [...byTool].map(([tool, count]) => `${tool} x${count}`).join(', ') },
            { label: 'example', text: denials[0].target || '(no target recorded)' },
          ],
        });
      }

      return { findings, notes: { corrections: corrections.length, denials: denials.length } };
    },
  };
}

module.exports = { createCorrectionDetector, themeOf };
