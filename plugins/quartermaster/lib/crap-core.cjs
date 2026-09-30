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

// The pattern the gate has always counted definitions by (`function`, `=>`, `name(...) {`), so a file lizard gave no row is held to no less than before.
const DEFINITION = /\bfunction\b|=>|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function spansLine(row, line) {
  return row.start <= line && line <= row.end;
}

/**
 * Whether some definition in `text` starts on a line none of `rows` spans. Each definition is checked on
 * its own, so a row the source scan did read cannot stand in for one it could not read elsewhere in the file.
 */
function definitionOutsideRows(text, rows) {
  return Array.from(text.matchAll(DEFINITION), (match) => lineAt(text, match.index)).some((line) => !rows.some((row) => spansLine(row, line)));
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
// A `<...>` type-parameter list never reaches back past one of these.
const TYPE_PARAMETERS_FENCE = new Set([...RETURN_TYPE_STOP, '(']);
const EXPRESSION_STOP = new Set([',', ';', ')', ']', '}']);
const OPERAND_CLOSERS = new Set([')', ']', '}']);
// lizard's JavaScript-family conditions, except that `??` is one branch where lizard reads two ternaries.
const BRANCH_WORDS = new Set(['if', 'for', 'while', 'case', 'catch']);
const BRANCH_OPERATORS = new Set(['&&', '||', '??']);
// A `?` before one of these marks an optional parameter or property, which is no branch.
const OPTIONAL_MARK_BEFORE = new Set([':', ')', ',']);
// `promise.catch(...)` is a method call, not a catch clause.
const MEMBER_ACCESS = new Set(['.', '?.']);
const SCANNED_SOURCE = 'source-scan';
const ANONYMOUS = '(anonymous)';
const ASSIGNMENT_MARKS = new Set(['=', ':']);
// A paren group after one of these is a condition, an operand or a call, never a parameter list.
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'of', 'else', 'do', 'case', 'throw', 'async']);
const CALL_PREFIX = new Set(['.', '?.', 'new', 'extends']);
const NO_TOKEN ={ value: undefined, kind: undefined, line: 0 };
const NESTED_BODY_END = new Map([['=>', arrowBodyEnd], ['function', functionKeywordBodyEnd]]);

/** A regex's character class may hold an unescaped `/`, so it is stepped over whole; one left open ends the search for a close. */
function characterClassEnd(text, index) {
  const close = closingOnLine(text, index, ']');
  return close < 0 ? text.length : close;
}

/** The last index of what starts at `cursor` inside a literal: an escape pair, a regex's character class, or the character alone. */
function literalUnitEnd(text, cursor, quote) {
  if (text[cursor] === '\\') return cursor + 1;
  return quote === '/' && text[cursor] === '[' ? characterClassEnd(text, cursor) : cursor;
}

function closingOnLine(text, index, quote) {
  for (let cursor = index + 1; cursor < text.length && text[cursor] !== '\n'; cursor = literalUnitEnd(text, cursor, quote) + 1) {
    if (text[cursor] === quote) return cursor;
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

function functionSignature(tokens, open) {
  const close = matchingClose(tokens, open);
  if (close < 0) return null;
  const start = bodyStart(tokens, close);
  const end = bodyEnd(tokens, start);
  return end < 0 ? null : { open, close, start, end };
}

function nestedParenSignature(tokens, open) {
  const signature = functionSignature(tokens, open);
  return signature && hasNestedParen(tokens, open, signature.close) ? signature : null;
}

function signatureAt(tokens, open, name) {
  return parameterListCandidate(tokens, open, name) ? nestedParenSignature(tokens, open) : null;
}

/**
 * lizard's TypeScript, TSX and JavaScript readers close a declaration at the first `)` in its
 * parameter list, so a nested paren group there (a function-typed prop, a default arrow) ends the
 * function inside its own signature: neither the body's lines nor its branches reach lizard's row.
 * The parameter list and body of such a function, when its parameter list opens on the row's start line.
 */
function truncatedSignature(tokens, entry) {
  const name = ownName(entry.name);
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

/** The `<` opening the type-parameter list that closes at the `>` at `close`, or -1 when a fence comes first. */
function typeParametersOpen(tokens, close) {
  let depth = 0;
  for (let cursor = close; cursor >= 0 && !TYPE_PARAMETERS_FENCE.has(tokens[cursor].value); cursor -= 1) {
    depth -= ANGLE_STEP.get(tokens[cursor].value) || 0;
    if (depth === 0) return cursor;
  }
  return -1;
}

/** `index` when it is no `>`, else the index before the `<...>` type-parameter list that ends there. */
function beforeTypeParameters(tokens, index) {
  const open = tokenAt(tokens, index).value === '>' ? typeParametersOpen(tokens, index) : -1;
  return open < 0 ? index : open - 1;
}

/** lizard names a function expression after the variable or property it is assigned to. */
function assignedName(tokens, keyword) {
  const target = tokenAt(tokens, keyword - 1).value === 'async' ? keyword - 2 : keyword - 1;
  const owner = tokenAt(tokens, target - 1);
  return ASSIGNMENT_MARKS.has(tokenAt(tokens, target).value) && owner.kind === 'word' ? owner.value : ANONYMOUS;
}

/** The `function` keyword just before `index`, past a generator's `*`, or `index` itself when there is none. */
function functionKeywordStart(tokens, index) {
  if (tokenAt(tokens, index - 1).value === 'function') return index - 1;
  return tokenAt(tokens, index - 1).value === '*' && tokenAt(tokens, index - 2).value === 'function' ? index - 2 : index;
}

/** A word naming the function whose parameter list follows it, rather than a keyword or a callee. */
function definitionName(tokens, at) {
  const token = tokenAt(tokens, at);
  return token.kind === 'word' && !NOT_A_NAME.has(token.value) && !CALL_PREFIX.has(tokenAt(tokens, at - 1).value);
}

/** The token a function's row starts on and its name, for the paren at `open`; null when that paren is a call or a condition. */
function definitionHead(tokens, open) {
  const at = beforeTypeParameters(tokens, open - 1);
  // `function (` and `function* (` have no name of their own, so the keyword sits right before where one would be.
  const keyword = functionKeywordStart(tokens, at + 1);
  if (keyword <= at) return { first: keyword, name: assignedName(tokens, keyword) };
  return definitionName(tokens, at) ? { first: functionKeywordStart(tokens, at), name: tokenAt(tokens, at).value } : null;
}

/** lizard's name for a function can carry its owner (`exports.load`, `Store::fetch`) or accessor (`get size`); the source names it by the last word. */
function ownName(name) {
  return name.replace(/^.*(?:::|\.|\s)/, '');
}

function rowStart(line, name) {
  return `${line}\u0000${name}`;
}

/** lizard names a function whose own parameter list holds an arrow type (`work: () => T`) "(anonymous)"; a callback elsewhere on the line does not stand in for it. */
function arrowRowStandsIn(rowStarts, tokens, line, open, close) {
  return rowStarts.has(rowStart(line, ANONYMOUS)) && tokens.slice(open, close).some((token) => token.value === '=>');
}

function bracedSignature(tokens, open, signatureOf) {
  const signature = signatureOf(tokens, open);
  return signature && tokens[signature.start].value === '{' ? signature : null;
}

/** Arrows are left out: lizard keeps a row for an arrow whose parameter list holds a call. */
function scannedEntry(tokens, file, open, { rowStarts, signatureOf }) {
  const head = definitionHead(tokens, open);
  if (!head || rowStarts.has(rowStart(tokens[head.first].line, head.name))) return null;
  const signature = bracedSignature(tokens, open, signatureOf);
  if (!signature) return null;
  const { close, start, end } = signature;
  if (arrowRowStandsIn(rowStarts, tokens, tokens[head.first].line, open, close)) return null;
  const complexity = 1 + branchCount(tokens, open, close) + branchCount(tokens, start + 1, end);
  return { file, name: head.name, complexity, start: tokens[head.first].line, end: tokens[end].line, source: SCANNED_SOURCE };
}

/** A row already stands for a definition when it starts on the definition's line under the same name, or as (anonymous) when its parameter list holds an arrow; another named function there does not. */
function definitionsWithoutRow(tokens, file, rows, signatureOf) {
  const scan = { rowStarts: new Set(rows.map((entry) => rowStart(entry.start, ownName(entry.name)))), signatureOf };
  const found = [];
  for (let open = 0; open < tokens.length; open += 1) {
    const entry = tokens[open].value === '(' ? scannedEntry(tokens, file, open, scan) : null;
    if (entry) found.push(entry);
  }
  return found;
}

/** One past the highest ordinal lizard gave each name. */
function nextOrdinals(present) {
  const next = new Map();
  for (const entry of present) next.set(entry.name, Math.max(next.get(entry.name) || 0, entry.ordinal + 1));
  return next;
}

/** Numbered after the rows lizard did give the same name, so no scanned row takes a lizard row's identity. */
function withOrdinals(scanned, present) {
  const nextOrdinal = nextOrdinals(present);
  return scanned.map((entry) => {
    const ordinal = nextOrdinal.get(entry.name) || 0;
    nextOrdinal.set(entry.name, ordinal + 1);
    return { ...entry, ordinal };
  });
}

/**
 * lizard reports no row at all for a `function`, method or constructor whose parameter list holds a call
 * (`a = f(), b`), so that function is never scored. A definition with such a parameter list, unless a row
 * of the same name (or an "(anonymous)" one) starts on its line, is read from the source instead. It has no lizard complexity to
 * compare, so its own branch count stands alone. lizard is also left unable to read some plain functions
 * after it, so once a dropped function is found, every other definition in the file without a row is read
 * the same way.
 */
function scannedEntries(tokens, file, present) {
  const dropped = definitionsWithoutRow(tokens, file, present, nestedParenSignature);
  if (!dropped.length) return [];
  const lost = definitionsWithoutRow(tokens, file, [...present, ...dropped], functionSignature);
  return withOrdinals([...dropped, ...lost].sort((left, right) => left.start - right.start), present);
}

function groupByFile(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (byFile.has(entry.file)) byFile.get(entry.file).push(entry);
    else byFile.set(entry.file, [entry]);
  }
  return byFile;
}

/**
 * Gives every JavaScript-family lizard row that stops inside its own parameter list the function's real
 * body and that body's branch count, so coverage, the source-text fingerprint and CRAP all read the
 * function lizard named, and adds a row for each function lizard dropped altogether. `readText` returns
 * a file's source, or null when it cannot be read; that file's rows stay as lizard gave them, so a
 * truncated one finds no coverage and is reported unverified. `extraFiles` are files lizard gave no
 * row at all, which a dropped function can leave.
 */
function withBodySpans(entries, readText, extraFiles = []) {
  const tokensByFile = new Map();
  const tokensOf = (file) => (SCRIPT_SOURCE.test(file) ? fileTokens(tokensByFile, file, readText) : null);
  const widened = entries.map((entry) => {
    const tokens = tokensOf(entry.file);
    return tokens ? widenedEntry(tokens, entry) : entry;
  });
  const rowsByFile = groupByFile(entries);
  const files = new Set([...rowsByFile.keys(), ...extraFiles]);
  const scanned = [...files].flatMap((file) => {
    const tokens = tokensOf(file);
    return tokens ? scannedEntries(tokens, file, rowsByFile.get(file) ?? []) : [];
  });
  return [...widened, ...scanned];
}

module.exports = { SCANNED_SOURCE, crapScore, definitionOutsideRows, parseLizardCsv, splitCsvRow, withBodySpans };
