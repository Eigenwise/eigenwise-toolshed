'use strict';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:[\\/][\w.@~+-]+)+[\\/]?/g;
const HEX = /\b[0-9a-f]{7,}\b/gi;
const NUMBER = /\b\d{2,}\b/g;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[\s\S]*/;

/**
 * Applied to everything the report shows. A retro reads real commands out of real transcripts, and
 * those commands carry dispatch tokens, API keys, and bearer headers; a report that quotes one has
 * copied a live credential into a file and into a model's context. Redaction runs last and blind, so
 * a pattern nobody anticipated is still caught by the generic high-entropy rule.
 */
const REDACTIONS = [
  [/(--?(?:token|api-?key|secret|password|auth)[= ]+)(\S+)/gi, '$1<redacted>'],
  [/\b((?:token|api_?key|secret|password|passwd|authorization)\s*[:=]\s*)["']?[\w.~+/-]{8,}["']?/gi, '$1<redacted>'],
  [/\bBearer\s+[\w.~+/-]{16,}=*/gi, 'Bearer <redacted>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '<redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>'],
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '<redacted private key>'],
  // Long mixed-case alphanumeric runs are credentials far more often than they are anything a reader
  // needs. Hashes and ids are already replaced with tokens by this point.
  [/\b(?=[A-Za-z0-9]{24,}\b)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}\b/g, '<redacted>'],
];

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let value = text;
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  return value;
}

/** Recursively redacts every string in a structure, so no reporting path can forget to call it. */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = redactDeep(item);
    return output;
  }
  return value;
}

// Shapes whose repetition says nothing worth acting on: navigating and looking around is not a chore
// a script would remove.
const TRIVIAL_HEADS = new Set([
  'ls', 'cd', 'pwd', 'clear', 'echo', 'dir', 'whoami', 'date', 'which', 'where',
  'Get-Location', 'Set-Location', 'Get-ChildItem', 'Write-Host', 'Write-Output',
  'git status', 'git diff', 'git log', 'git branch',
]);

const MULTIPLEXERS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pip', 'docker',
  'gh', 'cargo', 'go', 'dotnet', 'kubectl', 'terraform', 'sidequest',
]);

/**
 * Replaces the parts of a command that vary between runs with slot tokens, so two invocations that
 * differ only by which file they targeted collapse to one shape. The captured slot values are what a
 * parameterized script would take as arguments, so they are returned rather than discarded.
 */
function normalizeCommand(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { shape: '', slots: [] };

  // A heredoc body is file content, not a command. Keeping it would cluster every appended chunk as
  // its own shape and bury the actual signal, which is that a file is being built by appending.
  text = text.replace(HEREDOC, '<<heredoc');

  const slots = [];
  const substitute = (pattern, token) => {
    text = text.replace(pattern, (match) => {
      slots.push({ token, value: match });
      return token;
    });
  };

  substitute(UUID, '<uuid>');
  substitute(ABSOLUTE_PATH, '<path>');
  substitute(HEX, '<hash>');
  substitute(NUMBER, '<n>');

  return { shape: text.replace(/\s+/g, ' ').trim(), slots };
}

// Flags that carry a value, so `git -C <dir> status` reduces to `git status` rather than `git -C`.
// Without this, the same chore run inside a worktree never groups with the same chore run at the root.
const VALUE_FLAGS = new Set(['-C', '-c', '-w', '-d', '--prefix', '--cwd', '--git-dir', '--work-tree', '--directory', '--chdir']);

function commandHead(shape) {
  const tokens = String(shape ?? '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const first = tokens[0];
  if (!MULTIPLEXERS.has(first)) return first;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token) && tokens[index + 1] && !tokens[index + 1].startsWith('-')) index += 1;
      continue;
    }
    if (/^["'<]/.test(token)) continue;
    return `${first} ${token}`;
  }
  return first;
}

function isTrivialShape(shape) {
  const head = commandHead(shape);
  if (!head) return true;
  if (TRIVIAL_HEADS.has(head)) return true;
  return TRIVIAL_HEADS.has(String(shape).split(/\s+/)[0]);
}

/**
 * Ranks how much a shape would benefit from being a script. A long piped command with flags is worth
 * capturing; a two-token invocation is already as short as a script call would be.
 */
function shapeComplexity(shape) {
  const text = String(shape ?? '');
  const tokens = text.split(/\s+/).filter(Boolean).length;
  const pipes = (text.match(/\||&&|;/g) ?? []).length;
  const flags = (text.match(/(?:^|\s)-{1,2}\w/g) ?? []).length;
  const lines = (text.match(/\n/g) ?? []).length;
  return tokens + pipes * 4 + flags * 2 + lines * 3 + Math.floor(text.length / 40);
}

/**
 * Names what changed between a failing invocation and the one that worked. The answer is the whole
 * point of a fail-then-fix finding: it is the correction that belongs in the generated script.
 */
function describeDelta(before, after) {
  const beforeTokens = String(before ?? '').split(/\s+/).filter(Boolean);
  const afterTokens = String(after ?? '').split(/\s+/).filter(Boolean);
  const beforeSet = new Set(beforeTokens);
  const afterSet = new Set(afterTokens);
  const added = afterTokens.filter((token) => !beforeSet.has(token));
  const removed = beforeTokens.filter((token) => !afterSet.has(token));
  return { added: added.slice(0, 8), removed: removed.slice(0, 8) };
}

module.exports = {
  commandHead,
  describeDelta,
  isTrivialShape,
  normalizeCommand,
  redact,
  redactDeep,
  shapeComplexity,
  TRIVIAL_HEADS,
  VALUE_FLAGS,
};
