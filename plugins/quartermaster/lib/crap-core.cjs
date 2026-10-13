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

/**
 * The pattern the gate has always counted definitions by (`function`, `=>`, `name(...) {`) in a language the
 * token scan cannot read, so such a file lizard gave no row is held to no less than before. Built from a string:
 * lizard reads a regex literal as code, and an unbalanced `(` or `{` in one shifts every later row in the file up a line.
 */
const RAW_DEFINITION = new RegExp('\\bfunction\\b|=>|\\b[A-Za-z_$][\\w$]*\\s*\\([^)]*\\)\\s*\\{', 'g');

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function spansLine(row, line) {
  return row.start <= line && line <= row.end;
}

/** In a JavaScript-family file only code defines a function: `function` in a comment or a string is no definition (#433). */
function definitionLines(text, file) {
  if (!SCRIPT_SOURCE.test(file)) return Array.from(text.matchAll(RAW_DEFINITION), (match) => lineAt(text, match.index));
  const tokens = scriptTokens(text);
  return scriptDefinitions(tokens).map((definition) => tokens[definition.head].line);
}

/**
 * Whether some definition in `text` starts on a line none of `rows` spans. Each definition is checked on
 * its own, so a row the source scan did read cannot stand in for one it could not read elsewhere in the file.
 */
function definitionOutsideRows(text, rows, file) {
  return definitionLines(text, file).some((line) => !rows.some((row) => spansLine(row, line)));
}

const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/i;
// A template literal is a group from its opening backtick to this token at its closing one, so the code in its `${...}` stays inside it and its last line is known.
const TEMPLATE_CLOSE = '`end';
const OPENERS = new Set(['(', '[', '{', '`']);
const OPENER_FOR = new Map([[')', '('], [']', '['], ['}', '{'], [TEMPLATE_CLOSE, '`']]);
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
// lizard 1.24.0 loses its place at a template literal opened inside another one's `${...}` (#471).
const NESTED_TEMPLATE = 'nested-template';
// An arrow's parameter list after one of these opens a value. POSITION_RULES judges `=`, `(`, `[`, `,` and `:`, which also appear in types.
const VALUE_BEFORE = new Set(['{', '=>', '?', '&&', '||', '??', '!', '...', 'return', 'yield', 'await', 'default']);
// A paren group after one of these, or after a word, is a call's argument list.
const CALLEE_END = new Set([')', ']', '>', '?.']);
const LIST_GROUPS = new Set(['(', '[']);
// lizard can end a row on the line of the first token past these after a body (`fn: () => x,` then the next property).
const TRAILING_CLOSERS = new Set([',', ';', ')', ']', '}']);

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
  push(state, '`', state.templateDepth ? NESTED_TEMPLATE : 'literal', state.index + 1);
  state.templateDepth += 1;
  scanTemplateText(state);
  state.templateDepth -= 1;
}

function scanTemplateText(state) {
  while (state.index < state.text.length) {
    const pair = state.text.slice(state.index, state.index + 2);
    if (pair[0] === '`') return push(state, TEMPLATE_CLOSE, 'literal', state.index + 1);
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
  const state = { text, index: 0, line: 1, tokens: [], templateDepth: 0 };
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

/**
 * lizard names a function whose parameter list holds an arrow type (`work: () => T`) "(anonymous)" and ends that
 * row inside the list, so the row is this function's only when widening it lands on this parameter list. A
 * callback's row on the line widens elsewhere, and a default arrow (`work = () => {}`) gets a row of its own name.
 */
function anonymousRowStandsIn(rowStarts, tokens, line, open) {
  return rowStarts.has(rowStart(line, ANONYMOUS)) && truncatedSignature(tokens, { name: ANONYMOUS, start: line })?.open === open;
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
  if (anonymousRowStandsIn(rowStarts, tokens, tokens[head.first].line, open)) return null;
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
 * the same way. `lostPlace` says lizard lost its place in this file another way (#471), with the same result.
 */
function scannedEntries(tokens, file, present, lostPlace) {
  const dropped = definitionsWithoutRow(tokens, file, present, nestedParenSignature);
  if (!dropped.length && !lostPlace) return [];
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

/** Every group in the file closes, and with its own kind; otherwise a literal or JSX text was misread, and no span found here can overrule lizard's. */
function balancedGroups(tokens) {
  const stack = [];
  return tokens.every((token) => nesting(stack, token.value) >= 0) && !stack.length;
}

/** The index of the innermost group still open at each token, or -1 at the top level. */
function enclosingGroups(tokens) {
  const open = [];
  return tokens.map((token, index) => {
    const enclosing = open.length ? open[open.length - 1] : -1;
    if (OPENERS.has(token.value)) open.push(index);
    else if (OPENER_FOR.has(token.value)) open.pop();
    return enclosing;
  });
}

/** `type Name<T> = (...) => R` declares a function type, not a function. */
function typeAlias(tokens, equals) {
  return tokenAt(tokens, beforeTypeParameters(tokens, equals - 1) - 1).value === 'type';
}

function assignedValue(tokens, equals) {
  return !typeAlias(tokens, equals);
}

/** A call's arguments are values; any other paren or bracket group is whatever its own position makes it. */
function groupedValue(tokens, open, enclosing) {
  const previous = tokenAt(tokens, open - 1);
  return previous.kind === 'word' || CALLEE_END.has(previous.value) || valuePosition(tokens, open - 1, enclosing);
}

/** After `,` an arrow is an argument or an array element; in a generic's type arguments it is a function type. */
function listedValue(tokens, comma, enclosing) {
  const open = enclosing[comma];
  return LIST_GROUPS.has(tokenAt(tokens, open).value) && groupedValue(tokens, open, enclosing);
}

/** After `:` an arrow is an object literal's property; in an interface, a type literal or a parameter's annotation it is a function type. */
function propertyValue(tokens, colon, enclosing) {
  const open = enclosing[colon];
  return tokenAt(tokens, open).value === '{' && valuePosition(tokens, open - 1, enclosing);
}

const POSITION_RULES = new Map([['=', assignedValue], ['(', groupedValue], ['[', groupedValue], [',', listedValue], [':', propertyValue]]);

/** Whether what follows `before` is a value rather than a type, so an arrow there is a function, not a function type. */
function valuePosition(tokens, before, enclosing) {
  const { value } = tokenAt(tokens, before);
  const rule = POSITION_RULES.get(value);
  return rule ? rule(tokens, before, enclosing) : VALUE_BEFORE.has(value);
}

/** The token before an arrow's parameters, past its type parameters and any `async`. */
function arrowPrefix(tokens, first) {
  const before = beforeTypeParameters(tokens, first - 1);
  return tokenAt(tokens, before).value === 'async' ? before - 1 : before;
}

function arrowDefinition(tokens, open, close, arrow, enclosing) {
  return valuePosition(tokens, arrowPrefix(tokens, open), enclosing) ? { head: open, open, close, opener: arrow, end: arrowBodyEnd(tokens, arrow) } : null;
}

/** A `function`, method or constructor whose body is a `{`, or an arrow, after the parameter list closing at `close`. */
function definitionAfter(tokens, open, close, enclosing) {
  const opener = bodyStart(tokens, close);
  const kind = tokenAt(tokens, opener).value;
  if (kind === '=>') return arrowDefinition(tokens, open, close, opener, enclosing);
  const head = kind === '{' ? definitionHead(tokens, open) : null;
  return head && { head: head.first, open, close, opener, end: matchingClose(tokens, opener) };
}

function parenDefinition(tokens, open, enclosing) {
  const close = matchingClose(tokens, open);
  return close < 0 ? null : definitionAfter(tokens, open, close, enclosing);
}

/**
 * A definition read from the source: `head` is the token its row starts on, `open` and `close` bound its
 * parameters, `opener` is the `{` or `=>` that opens its body, and `end` is the body's last token, or -1
 * when the body never closes.
 */
function definitionAt(tokens, index, enclosing) {
  if (tokens[index].value === '(') return parenDefinition(tokens, index, enclosing);
  const loneParameter = tokens[index].kind === 'word' && tokenAt(tokens, index + 1).value === '=>';
  return loneParameter ? arrowDefinition(tokens, index, index, index + 1, enclosing) : null;
}

/** One definition per body opener: a parenthesised parameter list comes first, so a return type before `=>` is never read as a lone parameter. */
function scriptDefinitions(tokens) {
  const enclosing = enclosingGroups(tokens);
  const byOpener = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const definition = definitionAt(tokens, index, enclosing);
    if (definition && !byOpener.has(definition.opener)) byOpener.set(definition.opener, definition);
  }
  return [...byOpener.values()];
}

/**
 * The latest line lizard can end a row on and still have read the function whole: it ends a declaration
 * with a return type, or an arrow followed by `,`, on the line of the next token past the body's closers.
 */
function slackLine(tokens, end) {
  let next = end + 1;
  while (next < tokens.length - 1 && TRAILING_CLOSERS.has(tokens[next].value)) next += 1;
  return Math.max(tokens[end].line, tokenAt(tokens, next).line);
}

function definitionSpan(tokens, definition) {
  return { start: tokens[definition.head].line, end: tokens[definition.end].line, slack: slackLine(tokens, definition.end) };
}

function honestRow(tokens, definition, entry) {
  const span = definitionSpan(tokens, definition);
  return span.end <= entry.end && entry.end <= span.slack;
}

function latestEnding(definitions) {
  return definitions.reduce((latest, definition) => (latest && latest.end >= definition.end ? latest : definition), null);
}

/** lizard starts an arrow whose `=>` ends a line on the body's first line instead (#477). */
function startsBodyOn(tokens, definition, line) {
  const arrow = tokens[definition.opener];
  return arrow.value === '=>' && arrow.line < line && tokenAt(tokens, definition.opener + 1).line === line;
}

/**
 * The definition a lizard row stands for: one whose head is on the row's first line, or else the arrow
 * whose body lizard started the row on. A row that ends where some definition on its line ends is
 * lizard's honest read of it; otherwise the latest-ending definition there is the one it misread.
 */
function rowDefinition(tokens, definitions, entry) {
  const onLine = definitions.filter((definition) => tokens[definition.head].line === entry.start);
  return onLine.find((definition) => honestRow(tokens, definition, entry)) || latestEnding(onLine) || definitions.find((definition) => startsBodyOn(tokens, definition, entry.start)) || null;
}

function overran(span, entry) {
  return entry.end > span.slack;
}

function bracedBody(tokens, definition) {
  return tokens[definition.opener].value === '{' || tokenAt(tokens, definition.opener + 1).value === '{';
}

/** A row that swallowed what follows the body, starts after the body's arrow, or stops inside a `{` body. */
function misread(tokens, definition, span, entry) {
  return overran(span, entry) || span.start !== entry.start || (bracedBody(tokens, definition) && span.end > entry.end);
}

/**
 * The same branch rules a source-scan row counts by. An overrun row's count holds the branches of the
 * functions lizard swallowed (#471), so the body's own count replaces it; any other misread row's count
 * covers part of its own body at most, so it can only be raised (#476, #477). An honest row ends with the
 * body: lizard ends it on the next token's line, which can be the next function's signature, and a change
 * there is no change to this function.
 */
function reconciledEntry(tokens, definition, entry) {
  if (!definition) return entry;
  const span = definitionSpan(tokens, definition);
  if (!misread(tokens, definition, span, entry)) return entry.end > span.end ? { ...entry, end: span.end } : entry;
  const counted = 1 + branchCount(tokens, definition.open, definition.close) + branchCount(tokens, definition.opener + 1, definition.end);
  return { ...entry, start: span.start, end: span.end, complexity: overran(span, entry) ? counted : Math.max(entry.complexity, counted) };
}

/**
 * Each lizard row is checked against the definition it stands for, and given that definition's real span
 * when lizard misread it. `clamped` says some row ran past its function's end, so lizard lost its place.
 */
function reconciledRows(tokens, rows) {
  if (!balancedGroups(tokens)) return { rows, clamped: false };
  const definitions = scriptDefinitions(tokens).filter((definition) => definition.end >= 0);
  const pairs = rows.map((entry) => [entry, rowDefinition(tokens, definitions, entry)]);
  return {
    rows: pairs.map(([entry, definition]) => reconciledEntry(tokens, definition, entry)),
    clamped: pairs.some(([entry, definition]) => definition && overran(definitionSpan(tokens, definition), entry)),
  };
}

function fileRows(tokens, file, rows) {
  if (!tokens) return rows;
  const reconciled = reconciledRows(tokens, rows);
  const lostPlace = reconciled.clamped || tokens.some((token) => token.kind === NESTED_TEMPLATE);
  return [...reconciled.rows, ...scannedEntries(tokens, file, reconciled.rows, lostPlace)];
}

/**
 * Gives every JavaScript-family lizard row that stops inside its own parameter list the function's real
 * body and that body's branch count, so coverage, the source-text fingerprint and CRAP all read the
 * function lizard named, reconciles every other row with the span of the definition it stands for, and
 * adds a row for each function lizard dropped altogether. `readText` returns a file's source, or null
 * when it cannot be read; that file's rows stay as lizard gave them, so a truncated one finds no
 * coverage and is reported unverified. `extraFiles` are files lizard gave no row at all, which a
 * dropped function can leave.
 */
function withBodySpans(entries, readText, extraFiles = []) {
  const tokensByFile = new Map();
  const tokensOf = (file) => (SCRIPT_SOURCE.test(file) ? fileTokens(tokensByFile, file, readText) : null);
  const rowsByFile = groupByFile(entries.map((entry) => {
    const tokens = tokensOf(entry.file);
    return tokens ? widenedEntry(tokens, entry) : entry;
  }));
  for (const file of extraFiles) if (!rowsByFile.has(file)) rowsByFile.set(file, []);
  return [...rowsByFile].flatMap(([file, rows]) => fileRows(tokensOf(file), file, rows));
}

function coveredLines(rows) {
  const lines = new Set();
  for (const row of rows) for (let line = row.start; line <= row.end; line += 1) lines.add(line);
  return lines;
}

/** In a file whose groups do not all balance, no body's end can be trusted, so each definition runs to the end of the file. */
function definitionRegions(tokens, lastLine) {
  const trusted = balancedGroups(tokens);
  return scriptDefinitions(tokens).map((definition) => ({ start: tokens[definition.head].line, end: trusted && definition.end >= 0 ? tokens[definition.end].line : lastLine }));
}

/** A definition inside `region` other than one of the very same span, which on a single line could be either's. */
function nestedIn(region, other) {
  return other.start >= region.start && other.end <= region.end && (other.start !== region.start || other.end !== region.end);
}

/**
 * The lines of each definition read from `text` that no row of its own spans, in order. A row measures
 * the definition it starts on, and a nested definition's lines are that definition's to measure: lizard
 * gives a nested function a row of its own, so one it dropped is unmeasured however far the parent's row
 * reaches. A changed line here is code lizard misread and no row measures, so the gate fails closed on
 * it rather than passing.
 */
function unmeasuredDefinitionLines(text, rows) {
  const regions = definitionRegions(scriptTokens(text), lineAt(text, text.length));
  const lines = new Set();
  for (const region of regions) {
    const measured = coveredLines([...rows.filter((row) => row.start === region.start), ...regions.filter((other) => nestedIn(region, other))]);
    for (let line = region.start; line <= region.end; line += 1) if (!measured.has(line)) lines.add(line);
  }
  return [...lines].sort((left, right) => left - right);
}

module.exports = { SCANNED_SOURCE, SCRIPT_SOURCE, crapScore, definitionOutsideRows, parseLizardCsv, splitCsvRow, unmeasuredDefinitionLines, withBodySpans };
