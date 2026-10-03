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

const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/i;
const OPENERS = new Set(['(', '[', '{']);
const OPENER_FOR = new Map([[')', '('], [']', '['], ['}', '{']]);
const QUOTES = new Set(['"', "'"]);
// A regex literal can only start where an operand is expected; `<` is left out so a JSX closing tag's `</` stays a slash.
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '&&', '||', '??', '{', ';', '=>', 'return', 'typeof', 'case']);
// A `{` right after one of these in a return-type annotation opens a type literal, not the function body.
const TYPE_LITERAL_AFTER = new Set([':', '|', '&', '<', ',', '=>', '?', '=']);
// `??` and `?.` are single tokens so a branch count can tell them from a ternary's `?`.
const OPERATOR = /[=][>]|&&|[|][|]|[?][?]|[?][.](?![0-9])/y;
const WORD = /[\w$#]+/y;
const TOKEN_PATTERNS = [[OPERATOR, 'punct'], [WORD, 'word']];
const BRACE_STEP = new Map([['{', 1], ['}', -1]]);
const ANGLE_STEP = new Map([['<', 1], ['>', -1]]);
const RETURN_TYPE_STOP = new Set([';', ')', ']', '}']);
const EXPRESSION_STOP = new Set([',', ';', ')', ']', '}']);
const OPERAND_CLOSERS = new Set([')', ']', '}']);
// lizard's JavaScript-family conditions, except that `??` is one branch where lizard reads two ternaries.
const BRANCH_WORDS = new Set(['if', 'for', 'while', 'case', 'catch']);
const BRANCH_OPERATORS = new Set(['&&', '||', '??']);
// A `?` before one of these marks an optional parameter or property, which is no branch.
const OPTIONAL_MARK_BEFORE = new Set([':', ')', ',']);
// `promise.catch(...)` is a method call, not a catch clause.
const MEMBER_ACCESS = new Set(['.', '?.']);
const NO_TOKEN = { value: undefined, kind: undefined, line: 0 };
const NESTED_BODY_END = new Map([['=>', arrowBodyEnd], ['function', functionKeywordBodyEnd]]);

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
      scanTemplateExpression(state);
    } else advance(state, state.index + (pair[0] === '\\' ? 2 : 1));
  }
}

/** Inside a template's `${`, the `}` that takes its own braces below zero hands control back to the template. */
function scanTemplateExpression(state) {
  let depth = 0;
  while (state.index < state.text.length) {
    depth += BRACE_STEP.get(state.text[state.index]) || 0;
    if (depth < 0) return advance(state, state.index + 1);
    scanToken(state);
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

function lineEnd(text, index) {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end;
}

function commentEnd(text, index) {
  const end = text.indexOf('*/', index + 2);
  return end < 0 ? text.length : end + 2;
}

/** Whitespace and comments leave no token: the index just past the one starting here, or `index` when none does. */
function triviaEnd(text, index) {
  const pair = text.slice(index, index + 2);
  if (pair === '//') return lineEnd(text, index);
  if (pair === '/*') return commentEnd(text, index);
  return /\s/.test(text[index]) ? index + 1 : index;
}

function startsDelimited(state, character) {
  return QUOTES.has(character) || (character === '/' && regexAllowed(state.tokens));
}

function scanLiteral(state) {
  const character = state.text[state.index];
  if (character === '`') scanTemplate(state);
  else if (startsDelimited(state, character)) scanDelimited(state, character);
  else return false;
  return true;
}

function scanOperatorOrWord(state) {
  const { text, index } = state;
  for (const [pattern, kind] of TOKEN_PATTERNS) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match) return push(state, match[0], kind, index + match[0].length);
  }
  return push(state, text[index], 'punct', index + 1);
}

function scanToken(state) {
  const skipped = triviaEnd(state.text, state.index);
  if (skipped > state.index) advance(state, skipped);
  else if (!scanLiteral(state)) scanOperatorOrWord(state);
}

function scriptTokens(text) {
  const state = { text, index: 0, line: 1, tokens: [] };
  while (state.index < text.length) scanToken(state);
  return state.tokens;
}

function tokenAt(tokens, index) {
  return tokens[index] || NO_TOKEN;
}

const FUNCTION_TOKENS = new Set(['function', '=>']);

/** A word then `(`, the first `)`, then `{`: a declaration or method head, and also `if (x) {`, which this guard over-counts on purpose. */
function opensBodyAfterWord(tokens, index) {
  if (tokens[index].kind !== 'word' || tokenAt(tokens, index + 1).value !== '(') return false;
  const close = tokens.findIndex((token, position) => position > index + 1 && token.value === ')');
  return close >= 0 && tokenAt(tokens, close + 1).value === '{';
}

/** Languages the JavaScript-family scan cannot read keep the raw-text count, which can only over-count. */
function rawFunctionTokenCount(text) {
  return text.match(/\bfunction\b|=>|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g)?.length ?? 0;
}

/**
 * Function-like tokens in code. Comments and string or template text leave no token, so only a real
 * `function`, `=>` or `name(...) {` counts; a template's `${...}` expression is code and still counts.
 */
function functionTokenCount(text, file) {
  if (file !== undefined && !SCRIPT_SOURCE.test(file)) return rawFunctionTokenCount(text);
  const tokens = scriptTokens(text);
  return tokens.filter((token, index) => FUNCTION_TOKENS.has(token.value) || opensBodyAfterWord(tokens, index)).length;
}

/** The group depth after `value`, or -1 when it closes a group of another kind, which means this scan misread the source. */
function nesting(stack, value) {
  if (OPENERS.has(value)) stack.push(value);
  else if (OPENER_FOR.has(value) && stack.pop() !== OPENER_FOR.get(value)) return -1;
  return stack.length;
}

/** A closer of the wrong kind answers -1, so the caller keeps lizard's row rather than trust a misread. */
function matchingClose(tokens, open) {
  const stack = [];
  for (let index = open; index < tokens.length; index += 1) {
    const depth = nesting(stack, tokens[index].value);
    if (depth <= 0) return depth < 0 ? -1 : index;
  }
  return -1;
}

/** A group that never closes ends past the last token, so every scan stepping over it stops there. */
function groupEnd(tokens, index) {
  if (!OPENERS.has(tokens[index].value)) return index;
  const close = matchingClose(tokens, index);
  return close < 0 ? tokens.length : close;
}

function bodyStartsHere(tokens, cursor, angleDepth) {
  const { value } = tokens[cursor];
  return angleDepth === 0 && (value === '=>' || (value === '{' && !TYPE_LITERAL_AFTER.has(tokens[cursor - 1].value)));
}

/** In a return-type annotation `<` and `>` are always generic brackets, so they fence off a `=>` or `{` inside them. */
function returnTypeEnd(tokens, index) {
  let angleDepth = 0;
  for (let cursor = index; cursor < tokens.length; cursor = groupEnd(tokens, cursor) + 1) {
    if (bodyStartsHere(tokens, cursor, angleDepth)) return cursor;
    if (RETURN_TYPE_STOP.has(tokens[cursor].value)) return -1;
    angleDepth += ANGLE_STEP.get(tokens[cursor].value) || 0;
  }
  return -1;
}

/** Without semicolons, a word opening a line after a finished operand starts the next statement. */
function statementBreak(previous, token) {
  return token.kind === 'word' && token.line > previous.line && (previous.kind !== 'punct' || OPERAND_CLOSERS.has(previous.value));
}

function endsExpression(tokens, cursor) {
  return EXPRESSION_STOP.has(tokens[cursor].value) || statementBreak(tokens[cursor - 1], tokens[cursor]);
}

/** The last token of an expression body, or -1 when there is none or a group inside it never closes. */
function expressionEnd(tokens, index) {
  let last = -1;
  for (let cursor = index; cursor < tokens.length && !endsExpression(tokens, cursor); cursor = last + 1) last = groupEnd(tokens, cursor);
  return last < tokens.length ? last : -1;
}

function arrowBodyEnd(tokens, arrow) {
  return tokenAt(tokens, arrow + 1).value === '{' ? matchingClose(tokens, arrow + 1) : expressionEnd(tokens, arrow + 1);
}

/** The `{` or `=>` that opens the body after a parameter list, past any return-type annotation. */
function bodyStart(tokens, close) {
  return tokenAt(tokens, close + 1).value === ':' ? returnTypeEnd(tokens, close + 2) : close + 1;
}

/** The body's last token, or -1 when no function body opens at `start`. */
function bodyEnd(tokens, start) {
  const { value } = tokenAt(tokens, start);
  if (value === '{') return matchingClose(tokens, start);
  return value === '=>' ? arrowBodyEnd(tokens, start) : -1;
}

/** Only `function`, an optional `*` and name, then the parameter list: anything else is left in the enclosing count. */
function functionKeywordBodyEnd(tokens, keyword) {
  const named = tokenAt(tokens, keyword + 1).value === '*' ? keyword + 2 : keyword + 1;
  const open = tokenAt(tokens, named).kind === 'word' ? named + 1 : named;
  const close = tokenAt(tokens, open).value === '(' ? matchingClose(tokens, open) : -1;
  return close < 0 ? -1 : bodyEnd(tokens, bodyStart(tokens, close));
}

/** lizard gives a nested function a row of its own, so its body is stepped over rather than counted twice. */
function nestedBodyEnd(tokens, index) {
  const find = NESTED_BODY_END.get(tokens[index].value);
  const end = find ? find(tokens, index) : -1;
  return end > index ? end : index;
}

function isBranch(tokens, index) {
  const { value, kind } = tokens[index];
  if (kind === 'word') return BRANCH_WORDS.has(value) && !MEMBER_ACCESS.has(tokenAt(tokens, index - 1).value);
  if (value === '?') return !OPTIONAL_MARK_BEFORE.has(tokenAt(tokens, index + 1).value);
  return BRANCH_OPERATORS.has(value);
}

function branchCount(tokens, from, to) {
  let count = 0;
  for (let cursor = from; cursor <= to; cursor = nestedBodyEnd(tokens, cursor) + 1) if (isBranch(tokens, cursor)) count += 1;
  return count;
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

function signatureAt(tokens, open, name) {
  if (!parameterListCandidate(tokens, open, name)) return null;
  const close = matchingClose(tokens, open);
  if (close < 0 || !hasNestedParen(tokens, open, close)) return null;
  const start = bodyStart(tokens, close);
  const end = bodyEnd(tokens, start);
  return end < 0 ? null : { open, close, start, end };
}

/**
 * lizard's TypeScript, TSX and JavaScript readers close a declaration at the first `)` in its
 * parameter list, so a nested paren group there (a function-typed prop, a default arrow) ends the
 * function inside its own signature: neither the body's lines nor its branches reach lizard's row.
 * The parameter list and body of such a function, when its parameter list opens on the row's start line.
 */
function truncatedSignature(tokens, entry) {
  const name = entry.name.replace(/^.*(?:::|\.)/, '');
  const [first, last] = tokenRangeOnLine(tokens, entry.start);
  for (let open = nameIndexOnLine(tokens, first, last, name); open < last; open += 1) {
    const signature = signatureAt(tokens, open, name);
    if (signature) return signature;
  }
  return null;
}

/** The count can only raise lizard's number: a row this scan misjudges keeps at least the complexity lizard gave it. */
function widenedEntry(tokens, entry) {
  const signature = truncatedSignature(tokens, entry);
  if (!signature) return entry;
  const { open, close, start, end } = signature;
  const complexity = 1 + branchCount(tokens, open, close) + branchCount(tokens, start + 1, end);
  return { ...entry, end: Math.max(entry.end, tokens[end].line), complexity: Math.max(entry.complexity, complexity) };
}

function fileTokens(cache, file, readText) {
  if (!cache.has(file)) {
    const text = readText(file);
    cache.set(file, text === null ? null : scriptTokens(text));
  }
  return cache.get(file);
}

/**
 * Gives every JavaScript-family lizard row that stops inside its own parameter list the function's real
 * body and that body's branch count, so coverage, the source-text fingerprint and CRAP all read the
 * function lizard named. `readText` returns a file's source, or null when it cannot be read; that file's
 * rows stay as lizard gave them, so a truncated one finds no coverage and is reported unverified.
 */
function withBodySpans(entries, readText) {
  const tokensByFile = new Map();
  return entries.map((entry) => {
    const tokens = SCRIPT_SOURCE.test(entry.file) ? fileTokens(tokensByFile, entry.file, readText) : null;
    return tokens ? widenedEntry(tokens, entry) : entry;
  });
}

module.exports = { crapScore, functionTokenCount, parseLizardCsv, splitCsvRow, withBodySpans };
