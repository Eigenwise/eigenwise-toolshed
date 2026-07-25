// Byte-span edits instead of parse-and-restringify, so a release commit changes only the
// version bytes and never reflows an unrelated 200-line manifest.

export class JsonEditError extends Error {}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && WHITESPACE.has(text[i])) i += 1;
  return i;
}

function scanString(text, index) {
  if (text[index] !== '"') throw new JsonEditError(`expected a string at offset ${index}`);
  let i = index + 1;
  let value = '';
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      const escaped = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escaped === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (!Object.hasOwn(simple, escaped)) throw new JsonEditError(`bad escape at offset ${i}`);
      value += simple[escaped];
      i += 2;
      continue;
    }
    if (char === '"') return { value, end: i + 1 };
    value += char;
    i += 1;
  }
  throw new JsonEditError(`unterminated string at offset ${index}`);
}

function scanValue(text, index) {
  const start = skipWhitespace(text, index);
  const char = text[start];
  if (char === '"') return scanString(text, start).end;
  if (char === '{' || char === '[') {
    const close = char === '{' ? '}' : ']';
    let i = skipWhitespace(text, start + 1);
    if (text[i] === close) return i + 1;
    for (;;) {
      if (char === '{') {
        i = skipWhitespace(text, i);
        i = scanString(text, i).end;
        i = skipWhitespace(text, i);
        if (text[i] !== ':') throw new JsonEditError(`expected ":" at offset ${i}`);
        i += 1;
      }
      i = scanValue(text, i);
      i = skipWhitespace(text, i);
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === close) return i + 1;
      throw new JsonEditError(`expected "," or "${close}" at offset ${i}`);
    }
  }
  let i = start;
  while (i < text.length && !WHITESPACE.has(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i += 1;
  if (i === start) throw new JsonEditError(`expected a value at offset ${start}`);
  return i;
}

export function findValueSpan(text, path) {
  let index = skipWhitespace(text, 0);
  for (const [depth, step] of path.entries()) {
    const trail = path.slice(0, depth + 1).join('.');
    const char = text[index];
    if (typeof step === 'number') {
      if (char !== '[') throw new JsonEditError(`expected an array at "${trail}"`);
      let i = skipWhitespace(text, index + 1);
      let position = 0;
      for (;;) {
        if (text[i] === ']') throw new JsonEditError(`index ${step} is out of range at "${trail}"`);
        const valueStart = skipWhitespace(text, i);
        if (position === step) { index = valueStart; break; }
        i = skipWhitespace(text, scanValue(text, valueStart));
        if (text[i] === ',') { i += 1; position += 1; continue; }
        throw new JsonEditError(`index ${step} is out of range at "${trail}"`);
      }
      continue;
    }
    if (char !== '{') throw new JsonEditError(`expected an object at "${trail}"`);
    let i = skipWhitespace(text, index + 1);
    let found = null;
    while (found === null) {
      if (text[i] === '}') break;
      const key = scanString(text, i);
      i = skipWhitespace(text, key.end);
      if (text[i] !== ':') throw new JsonEditError(`expected ":" at offset ${i}`);
      const valueStart = skipWhitespace(text, i + 1);
      if (key.value === step) { found = valueStart; break; }
      i = skipWhitespace(text, scanValue(text, valueStart));
      if (text[i] === ',') { i = skipWhitespace(text, i + 1); continue; }
      break;
    }
    if (found === null) throw new JsonEditError(`no key "${trail}" in this document`);
    index = found;
  }
  return { start: index, end: scanValue(text, index) };
}

export function readValue(text, path) {
  const span = findValueSpan(text, path);
  return JSON.parse(text.slice(span.start, span.end));
}

export function replaceValue(text, path, value) {
  const span = findValueSpan(text, path);
  return text.slice(0, span.start) + JSON.stringify(value) + text.slice(span.end);
}
