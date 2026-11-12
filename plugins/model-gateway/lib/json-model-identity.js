'use strict';

// Locate JSON member tokens without reserializing the surrounding document.
// Callers validate the envelope with JSON.parse first; numbers and escaped/opaque
// strings outside the selected identity path keep their exact wire spelling.
const DEPTH = Object.freeze({ '{': 1, '[': 1, '}': -1, ']': -1 });
const PUNCTUATION = new Set(['{', '}', '[', ']', ',', ':']);
function stringEnd(text, start) {
  let index = start + 1;
  while (index < text.length && text.charCodeAt(index) !== 34) {
    index += text.charCodeAt(index) === 92 ? 2 : 1;
  }
  if (index >= text.length) throw new Error('Antigravity JSON string is incomplete');
  return index + 1;
}

function valueEnd(text, start) {
  let index = start;
  while (index < text.length && text.charCodeAt(index) > 32 && !PUNCTUATION.has(text[index])) index++;
  return index;
}

function tokenEnd(text, index) {
  if (text[index] === '"') return stringEnd(text, index);
  return PUNCTUATION.has(text[index]) ? index + 1 : valueEnd(text, index);
}

function* tokens(text) {
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) <= 32) { index++; continue; }
    const start = index;
    index = tokenEnd(text, index);
    yield { 0: text.slice(start, index), index: start };
  }
}

function recordKey(state, token) {
  state.key = JSON.parse(token[0]);
  state.expectKey = false;
}

function recordSpan(state, end) {
  state.spans.push([state.start, end]);
  state.start = null;
}

function beginValue(state, token) {
  if (state.previous !== ':' || state.key !== state.property) return;
  state.start = token.index;
  if (!['{', '['].includes(token[0])) recordSpan(state, token.index + token[0].length);
}

function inspectToken(state, token) {
  if (state.depth !== 1) return;
  if (state.expectKey) return recordKey(state, token);
  beginValue(state, token);
}

function finishCompoundValue(state, token) {
  if (state.start === null || state.depth !== 1) return;
  recordSpan(state, token.index + 1);
}

function advance(state, token) {
  inspectToken(state, token);
  state.depth += DEPTH[token[0]] || 0;
  if (['}', ']'].includes(token[0])) finishCompoundValue(state, token);
  if (state.depth === 1 && ['{', ','].includes(token[0])) state.expectKey = true;
  state.previous = token[0];
}

function propertySpan(text, property) {
  const state = { property, depth: 0, expectKey: false, previous: '', key: null, start: null, spans: [] };
  for (const token of tokens(text)) advance(state, token);
  if (state.spans.length !== 1) throw new Error('Antigravity requires one unambiguous envelope model identity.');
  return state.spans[0];
}

function replaceJsonPath(text, keys, value) {
  const [start, end] = propertySpan(text, keys[0]);
  const replacement = keys.length === 1 ? JSON.stringify(value) : replaceJsonPath(text.slice(start, end), keys.slice(1), value);
  return text.slice(0, start) + replacement + text.slice(end);
}

function replaceModelIdentity(raw, model, keys = ['model']) {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  return Buffer.from(replaceJsonPath(text, keys, model));
}

module.exports = { replaceModelIdentity, jsonTokens: tokens };
