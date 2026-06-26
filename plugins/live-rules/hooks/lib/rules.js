'use strict';
/**
 * live-rules - shared hook library
 *
 * Pure Node stdlib, no external dependencies, cross-platform. Loaded by both
 * hook entry scripts. Every function is written to fail soft: a malformed rule
 * file degrades to "skip that rule", never to a thrown error that could break a
 * prompt or an edit. The entry scripts wrap everything in try/catch and exit 0.
 *
 * All rules live in ONE Markdown file (by default .claude/live-rules.md at the
 * project root; override with the LIVE_RULES_PATH env var). The file holds any
 * number of rules, each a YAML frontmatter block followed by its body, with the
 * next "---" fence starting the next rule:
 *
 *   ---
 *   description: React component conventions   # human title for the rule
 *   globs: ["**\/*.tsx", "**\/*.jsx"]          # path-scoped  -> PreToolUse
 *   dirs:  ["packages/api"]                     # dir-scoped   -> PreToolUse + cwd
 *   prompt: ["deploy", "/migrat(e|ion)/i"]      # keyword      -> UserPromptSubmit
 *   priority: 10                                # higher injects first (default 0)
 *   enabled: true                              # default true
 *   ---
 *   - Prefer function components.
 *   - No inline styles; use CSS modules.
 *
 * Scope is inferred from which fields are present. A rule that declares none of
 * globs/dirs/prompt is "always-on" and injected on every prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stay safely under Claude Code's 10,000-char cap on injected context; the
// header plus the system-reminder wrapping eat into that budget too.
const CONTEXT_CAP = 9000;

/* ------------------------------------------------------------------ *
 *  Input / environment
 * ------------------------------------------------------------------ */

function readStdin() {
  // Hook input arrives as a single JSON object on stdin.
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function getProjectDir(data) {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    (data && typeof data.cwd === 'string' && data.cwd) ||
    process.cwd()
  );
}

/* ------------------------------------------------------------------ *
 *  Minimal YAML-subset frontmatter parser
 *  Supports: scalars (string/bool/number/null), inline arrays [a, b],
 *  block arrays (- item), quoted strings, and "# comments". Not full YAML.
 * ------------------------------------------------------------------ */

// A quote only opens a quoted scalar at a token boundary (start, or after
// whitespace / "[" / ","), matching YAML flow-scalar semantics. That way a lone
// apostrophe inside an unquoted value ("don't") stays literal instead of
// swallowing the rest of the line.
function isQuoteBoundary(prev) {
  return prev === '' || prev === ' ' || prev === '\t' || prev === '[' || prev === ',';
}

function stripComment(s) {
  let quote = null;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && isQuoteBoundary(j === 0 ? '' : s[j - 1])) {
      quote = ch;
    } else if (ch === '#' && (j === 0 || /\s/.test(s[j - 1]))) {
      return s.slice(0, j);
    }
  }
  return s;
}

function parseScalar(v) {
  v = String(v).trim();
  if (v === '') return '';
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseInlineArray(v) {
  const inner = v.replace(/^\[/, '').replace(/\][ \t]*$/, '');
  if (inner.trim() === '') return [];
  const parts = [];
  let cur = '';
  let quote = null; // active quote char inside a quoted element
  let depth = 0; // brace depth, so commas inside "{ts,tsx}" do not split
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && isQuoteBoundary(j === 0 ? '' : inner[j - 1])) {
      quote = ch;
      cur += ch;
    } else if (ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(parseScalar).filter((p) => p !== '' && p != null);
}

function parseYamlSubset(src) {
  const lines = src.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = stripComment(m[2]).trim();
    if (rest === '') {
      // A block list may follow on indented "- item" lines.
      const items = [];
      while (i < lines.length && /^[ \t]+-[ \t]+/.test(lines[i])) {
        items.push(parseScalar(stripComment(lines[i].replace(/^[ \t]+-[ \t]+/, '')).trim()));
        i++;
      }
      data[key] = items.length ? items : '';
    } else if (rest.startsWith('[')) {
      data[key] = parseInlineArray(rest);
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return data;
}

function parseFrontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.replace(/^﻿/, '') };
  return { data: parseYamlSubset(m[1]), body: m[2] };
}

/* ------------------------------------------------------------------ *
 *  Glob matching (pure Node, gitignore-style anchoring)
 * ------------------------------------------------------------------ */

const _globCache = new Map();

function escapeLiteral(s) {
  // Escape every regex metacharacter so glob literals (especially ".") stay literal.
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  // Strip a leading "./" or "/": paths are matched repo-relative, so a leading
  // slash is just the gitignore "anchor at root" idiom and is a no-op here.
  glob = String(glob).replace(/\\/g, '/').replace(/^\.?\//, '');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**" -> any depth, including zero directories
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else if (re.endsWith('/')) {
          re = re.slice(0, -1) + '(?:/.*)?'; // "a/b/**" also matches bare "a/b"
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*'; // "*" stays within a single path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeLiteral).join('|') + ')';
        i = end;
      }
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp('^' + re + '$');
}

function compiledGlob(glob) {
  let re = _globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    _globCache.set(glob, re);
  }
  return re;
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * gitignore-style match: a pattern with no "/" matches the basename at any
 * depth (so "*.sql" matches "db/x.sql"); a pattern containing "/" is anchored
 * to the repo-relative path.
 */
function ruleGlobMatches(glob, relPath) {
  const p = normPath(relPath);
  if (compiledGlob(glob).test(p)) return true;
  if (!String(glob).includes('/')) {
    const base = p.split('/').pop();
    if (compiledGlob(glob).test(base)) return true;
  }
  return false;
}

function normalizeDir(d) {
  return normPath(d).replace(/\/+$/, '');
}

function pathInDir(relPath, dir) {
  const p = normPath(relPath);
  const d = normalizeDir(dir);
  if (d === '' || d === '.') return true;
  return p === d || p.startsWith(d + '/');
}

/* ------------------------------------------------------------------ *
 *  Prompt-keyword matching: literal substring (case-insensitive) or /regex/flags
 * ------------------------------------------------------------------ */

function compilePromptPattern(p) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(String(p));
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2] || '');
  } catch (_) {
    return null;
  }
}

function promptMatches(pattern, text) {
  if (!text) return false;
  const re = compilePromptPattern(pattern);
  if (re) return re.test(text);
  return text.toLowerCase().includes(String(pattern).toLowerCase());
}

/* ------------------------------------------------------------------ *
 *  Rule loading
 * ------------------------------------------------------------------ */

function toArray(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String).map((s) => s.trim()).filter(Boolean);
}

function buildRule(id, data, body) {
  data = data || {};
  const globs = toArray(data.globs).concat(toArray(data.glob));
  const dirs = toArray(data.dirs).concat(toArray(data.dir)).map(normalizeDir).filter(Boolean);
  const prompts = toArray(data.prompt)
    .concat(toArray(data.prompts))
    .concat(toArray(data.keywords));

  let priority = 0;
  if (typeof data.priority === 'number' && Number.isFinite(data.priority)) {
    priority = data.priority;
  } else if (data.priority != null && /^-?\d+(\.\d+)?$/.test(String(data.priority).trim())) {
    priority = Number(data.priority);
  }

  return {
    id,
    description: data.description != null ? String(data.description).trim() : '',
    globs,
    dirs,
    prompts,
    priority,
    enabled: data.enabled !== false,
    body: String(body || '').trim(),
  };
}

function isAlways(rule) {
  return rule.globs.length === 0 && rule.dirs.length === 0 && rule.prompts.length === 0;
}

// Default single-file location, relative to the project root. Overridable with
// the LIVE_RULES_PATH env var (absolute, project-relative, or "~"-relative).
const DEFAULT_RULES_FILE = path.join('.claude', 'live-rules.md');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the one Markdown file that holds every rule. The env override lets a
// user keep rules anywhere convenient (a shared doc, a home-dir file, etc.).
function getRulesFile(projectDir) {
  const env = process.env.LIVE_RULES_PATH;
  const raw = env && String(env).trim() ? expandHome(String(env).trim()) : DEFAULT_RULES_FILE;
  return path.isAbsolute(raw) ? raw : path.join(projectDir, raw);
}

// A short, readable form of the rules-file path for headers: repo-relative with
// forward slashes when the file is inside the project, otherwise the full path.
function displayPath(projectDir, file) {
  try {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch (_) {
    /* fall through */
  }
  return String(file).replace(/\\/g, '/');
}

function isFence(line) {
  return line.replace(/^﻿/, '').trim() === '---';
}

/**
 * Split the rules file into rule sections. Each rule is a frontmatter block
 * (between two "---" fences) followed by its body, which runs up to the next
 * opening fence. The "---" lines pair up as open/close, open/close, ...:
 * fences[0..1] fence the first rule's frontmatter and fences[1..2] bound its
 * body, and so on. Content before the first fence (a title or intro) is ignored,
 * and a dangling unmatched fence at the end is skipped. A body must therefore
 * not contain a bare "---" line (use *** or ___ for a horizontal rule).
 */
function splitSections(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) fences.push(i);
  }
  const sections = [];
  for (let k = 0; k + 1 < fences.length; k += 2) {
    const open = fences[k];
    const close = fences[k + 1];
    const next = k + 2 < fences.length ? fences[k + 2] : lines.length;
    const fmSrc = lines.slice(open + 1, close).join('\n');
    const body = lines.slice(close + 1, next).join('\n');
    let data = {};
    try {
      data = parseYamlSubset(fmSrc);
    } catch (_) {
      data = {};
    }
    sections.push({ data, body });
  }
  return sections;
}

function loadRules(projectDir) {
  const file = getRulesFile(projectDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return []; // no rules file -> no rules, silently
  }
  const base = path.basename(file);
  const sections = splitSections(text);
  const rules = [];
  for (let i = 0; i < sections.length; i++) {
    try {
      rules.push(buildRule(base + '#' + (i + 1), sections[i].data, sections[i].body));
    } catch (_) {
      /* skip malformed section */
    }
  }
  return rules;
}

/* ------------------------------------------------------------------ *
 *  Selection
 * ------------------------------------------------------------------ */

function sortSelected(selected) {
  return selected.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });
}

function truncLabel(s) {
  s = String(s);
  return s.length > 28 ? s.slice(0, 27) + '...' : s;
}

// UserPromptSubmit: always-on rules, prompt-keyword matches, and dir rules
// whose directory contains the session cwd.
function selectForPrompt(rules, ctx) {
  const out = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (isAlways(rule)) {
      out.push({ rule, label: 'always' });
      continue;
    }
    let label = null;
    for (const p of rule.prompts) {
      if (promptMatches(p, ctx.promptText)) {
        label = 'prompt:' + truncLabel(p);
        break;
      }
    }
    if (!label && ctx.cwdRel != null) {
      for (const d of rule.dirs) {
        if (pathInDir(ctx.cwdRel, d)) {
          label = 'cwd:' + d;
          break;
        }
      }
    }
    if (label) out.push({ rule, label });
  }
  return sortSelected(out);
}

// PreToolUse: glob rules matching the edited file, and dir rules whose
// directory contains the edited file. Always-on rules are skipped here (the
// prompt hook already carries them).
function selectForEdit(rules, relPath) {
  const out = [];
  for (const rule of rules) {
    if (!rule.enabled || isAlways(rule)) continue;
    let label = null;
    for (const g of rule.globs) {
      if (ruleGlobMatches(g, relPath)) {
        label = g;
        break;
      }
    }
    if (!label) {
      for (const d of rule.dirs) {
        if (pathInDir(relPath, d)) {
          label = 'dir:' + d;
          break;
        }
      }
    }
    if (label) out.push({ rule, label });
  }
  return sortSelected(out);
}

/* ------------------------------------------------------------------ *
 *  Rendering + output
 * ------------------------------------------------------------------ */

function renderRules(selected, header) {
  const TRUNC = '\n(rule body truncated to fit the context limit; see your live-rules file)\n';
  let out = header + '\n';
  let included = 0;
  for (let k = 0; k < selected.length; k++) {
    const { rule, label } = selected[k];
    const title = rule.description || rule.id;
    const body = rule.body ? '\n' + rule.body : '';
    const block = '\n[' + label + '] ' + title + body + '\n';

    if (out.length + block.length > CONTEXT_CAP) {
      const remaining = selected.length - k;
      if (included > 0) {
        // Some full rules already fit; stop and note how many are held back.
        out +=
          '\n(' +
          remaining +
          ' more matching rule(s) not shown to stay within the context limit; see your live-rules file.)\n';
      } else {
        // The highest-priority rule alone overflows: truncate its body so the
        // emitted string still honors the cap rather than spilling whole.
        const budget = CONTEXT_CAP - out.length - TRUNC.length;
        if (budget > 0) out += block.slice(0, budget) + TRUNC;
        if (remaining > 1 && out.length + 80 < CONTEXT_CAP) {
          out += '(' + (remaining - 1) + ' more matching rule(s) not shown; see your live-rules file.)\n';
        }
      }
      break;
    }
    out += block;
    included++;
  }
  return out;
}

function emit(eventName, context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    })
  );
}

module.exports = {
  CONTEXT_CAP,
  readStdin,
  getProjectDir,
  parseFrontmatter,
  globToRegExp,
  ruleGlobMatches,
  pathInDir,
  promptMatches,
  compilePromptPattern,
  buildRule,
  isAlways,
  getRulesFile,
  displayPath,
  splitSections,
  loadRules,
  selectForPrompt,
  selectForEdit,
  renderRules,
  emit,
};
