'use strict';

function splitCsvRow(row) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (quoted && character === '"') {
      if (row[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
    } else if (quoted) field += character;
    else if (character === '"') quoted = true;
    else if (character === ',') { fields.push(field); field = ''; }
    else field += character;
  }
  fields.push(field);
  return fields;
}

function parseLizardCsv(csvText) {
  const functions = [];
  const ordinals = new Map();
  for (const row of csvText.split(/\r?\n/)) {
    const fields = splitCsvRow(row);
    if (fields.length < 11) continue;
    const complexity = Number(fields[1]);
    const start = Number(fields[9]);
    const end = Number(fields[10]);
    if (![complexity, start, end].every(Number.isFinite)) continue;
    const file = fields[6];
    const name = fields[7];
    const ordinalKey = `${file}\u0000${name}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    functions.push({ file, name, ordinal, complexity, start, end });
  }
  return functions;
}

function crapScore(complexity, coverage) {
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

function functionTokenCount(text) {
  return text.match(/\bfunction\b|=>|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g)?.length ?? 0;
}

const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/i;
const OPENERS = new Set(['(', '[', '{']);
const OPENER_FOR = new Map([[')', '('], [']', '['], ['}', '{']]);
// A regex literal can only start where an operand is expected; `<` is left out so a JSX closing tag's `</` stays a slash.
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '=>', 'return', 'typeof', 'case']);
// A `{` right after one of these in a return-type annotation opens a type literal, not the function body.
const TYPE_LITERAL_AFTER = new Set([':', '|', '&', '<', ',', '=>', '?', '=']);
const WORD = /[\w$#]+/y;

function closingOnLine(text, index, quote) {
  for (let cursor = index + 1; cursor < text.length && text[cursor] !== '\n'; cursor += 1) {
    if (text[cursor] === '\\') cursor += 1;
    else if (text[cursor] === quote) return cursor;
  }
  return -1;
}

function advance(state, to) {
  for (let cursor = state.index; cursor < to; cursor += 1) if (state.text[cursor] === '\n') state.line += 1;
  state.index = to;
}

function push(state, value, kind, to) {
  state.tokens.push({ value, kind, line: state.line });
  advance(state, to);
}

function scanTemplate(state) {
  push(state, '`', 'literal', state.index + 1);
  while (state.index < state.text.length) {
    const pair = state.text.slice(state.index, state.index + 2);
    if (pair[0] === '`') return advance(state, state.index + 1);
    if (pair === '${') {
      advance(state, state.index + 2);
      scanCode(state, true);
    } else advance(state, state.index + (pair[0] === '\\' ? 2 : 1));
  }
}

function regexAllowed(tokens) {
  const previous = tokens[tokens.length - 1];
  return !previous || REGEX_AFTER.has(previous.value);
}

/**
 * JSX text is not a string, so an apostrophe in `<p>Don't</p>` must not open one. A quote or regex that
 * does not close on its own line cannot be a literal in valid code, so it is read as a lone character.
 */
function scanDelimited(state, delimiter) {
  const close = closingOnLine(state.text, state.index, delimiter);
  if (close < 0) push(state, delimiter, 'punct', state.index + 1);
  else push(state, delimiter, 'literal', close + 1);
}

function scanToken(state) {
  const { text, index } = state;
  const character = text[index];
  const pair = text.slice(index, index + 2);
  if (/\s/.test(character)) return advance(state, index + 1);
  if (pair === '//') return advance(state, text.includes('\n', index) ? text.indexOf('\n', index) : text.length);
  if (pair === '/*') return advance(state, text.includes('*/', index + 2) ? text.indexOf('*/', index + 2) + 2 : text.length);
  if (character === '`') return scanTemplate(state);
  if (character === '"' || character === "'" || (character === '/' && regexAllowed(state.tokens))) return scanDelimited(state, character);
  if (pair === '=>') return push(state, pair, 'punct', index + 2);
  WORD.lastIndex = index;
  const word = WORD.exec(text);
  if (word) return push(state, word[0], 'word', index + word[0].length);
  return push(state, character, 'punct', index + 1);
}

/** Inside a template's `${`, the `}` that brings its own braces back to zero hands control back to the template. */
function scanCode(state, insideTemplate) {
  let depth = 0;
  while (state.index < state.text.length) {
    const character = state.text[state.index];
    if (insideTemplate && character === '}' && depth === 0) return advance(state, state.index + 1);
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    scanToken(state);
  }
}

function scriptTokens(text) {
  const state = { text, index: 0, line: 1, tokens: [] };
  scanCode(state, false);
  return state.tokens;
}

/** A closer of the wrong kind means this scan misread the source, so it answers -1 and the caller keeps lizard's span. */
function matchingClose(tokens, open) {
  const stack = [];
  for (let index = open; index < tokens.length; index += 1) {
    const { value, kind } = tokens[index];
    if (kind !== 'punct') continue;
    if (OPENERS.has(value)) stack.push(value);
    else if (OPENER_FOR.has(value)) {
      if (stack.pop() !== OPENER_FOR.get(value)) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

function groupEnd(tokens, index) {
  return OPENERS.has(tokens[index].value) ? matchingClose(tokens, index) : index;
}

function bodyStartsHere(tokens, cursor, angleDepth) {
  const { value } = tokens[cursor];
  return angleDepth === 0 && (value === '=>' || (value === '{' && !TYPE_LITERAL_AFTER.has(tokens[cursor - 1].value)));
}

/** In a return-type annotation `<` and `>` are always generic brackets, so they fence off a `=>` or `{` inside them. */
function returnTypeEnd(tokens, index) {
  let angleDepth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const { value } = tokens[cursor];
    if (bodyStartsHere(tokens, cursor, angleDepth)) return cursor;
    if (value === ';' || OPENER_FOR.has(value)) return -1;
    if (value === '<' || value === '>') angleDepth += value === '<' ? 1 : -1;
    cursor = groupEnd(tokens, cursor);
    if (cursor < 0) return -1;
  }
  return -1;
}

function expressionEndLine(tokens, index) {
  let last = -1;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const { value } = tokens[cursor];
    if (value === ',' || value === ';' || OPENER_FOR.has(value)) break;
    cursor = groupEnd(tokens, cursor);
    if (cursor < 0) return null;
    last = cursor;
  }
  return last < 0 ? null : tokens[last].line;
}

function blockEndLine(tokens, open) {
  const close = matchingClose(tokens, open);
  return close < 0 ? null : tokens[close].line;
}

/** The last line of the body after a parameter list's closing paren, or null when no function body follows it. */
function bodyEndLine(tokens, close) {
  let next = close + 1;
  if (tokens[next]?.value === ':') next = returnTypeEnd(tokens, next + 1);
  const value = tokens[next]?.value;
  if (value === '{') return blockEndLine(tokens, next);
  if (value !== '=>') return null;
  return tokens[next + 1]?.value === '{' ? blockEndLine(tokens, next + 1) : expressionEndLine(tokens, next + 1);
}

function tokenRangeOnLine(tokens, line) {
  let first = 0;
  while (first < tokens.length && tokens[first].line < line) first += 1;
  let last = first;
  while (last < tokens.length && tokens[last].line === line) last += 1;
  return [first, last];
}

/** A call's paren follows a callee word; a parameter list follows punctuation, `function`, `async`, or the function's own name. */
function parameterListCandidate(tokens, index, name) {
  if (tokens[index].value !== '(') return false;
  const previous = tokens[index - 1];
  return !previous || previous.kind !== 'word' || ['function', 'async', name].includes(previous.value);
}

function hasNestedParen(tokens, open, close) {
  return tokens.slice(open + 1, close).some((token) => token.value === '(' && token.kind === 'punct');
}

function nameIndexOnLine(tokens, first, last, name) {
  for (let index = first; index < last; index += 1) if (tokens[index].value === name) return index;
  return first;
}

/**
 * lizard's TypeScript, TSX and JavaScript readers close a declaration at the first `)` in its
 * parameter list, so a nested paren group there (a function-typed prop, a default arrow) ends the
 * function inside its own signature and the body never enters its span. The body's real last line,
 * when such a parameter list opens on the row's start line and its body runs past lizard's end.
 */
function truncatedBodyEnd(tokens, entry) {
  const name = entry.name.split(/::|\./).pop();
  const [first, last] = tokenRangeOnLine(tokens, entry.start);
  for (let open = nameIndexOnLine(tokens, first, last, name); open < last; open += 1) {
    if (!parameterListCandidate(tokens, open, name)) continue;
    const close = matchingClose(tokens, open);
    if (close < 0 || !hasNestedParen(tokens, open, close)) continue;
    const end = bodyEndLine(tokens, close);
    if (end !== null) return end > entry.end ? end : entry.end;
  }
  return entry.end;
}

/**
 * Widens every JavaScript-family lizard row whose span stops inside its own parameter list to the real
 * body, so coverage and the source-text fingerprint both read the function lizard named. `readText`
 * returns a file's source, or null when it cannot be read, which leaves that file's rows as lizard gave them.
 */
function withBodySpans(entries, readText) {
  const tokensByFile = new Map();
  return entries.map((entry) => {
    if (!SCRIPT_SOURCE.test(entry.file)) return entry;
    if (!tokensByFile.has(entry.file)) {
      const text = readText(entry.file);
      tokensByFile.set(entry.file, text === null ? null : scriptTokens(text));
    }
    const tokens = tokensByFile.get(entry.file);
    const end = tokens ? truncatedBodyEnd(tokens, entry) : entry.end;
    return end === entry.end ? entry : { ...entry, end };
  });
}

module.exports = { crapScore, functionTokenCount, parseLizardCsv, splitCsvRow, withBodySpans };
