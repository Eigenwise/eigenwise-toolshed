// A deliberately tiny YAML subset: flat scalars, one level of nested map or list,
// inline [a, b] lists. Anything richer is rejected rather than guessed at, because a
// release engine that silently misreads a fragment publishes the wrong versions.

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DELIMITER = '---';

export class YamlError extends Error {}

function fail(line, message) {
  throw new YamlError(`line ${line}: ${message}`);
}

function unquote(raw, line) {
  const quote = raw[0];
  if (raw.length < 2 || raw.at(-1) !== quote) fail(line, `unterminated ${quote === '"' ? 'double' : 'single'}-quoted string`);
  const inner = raw.slice(1, -1);
  if (quote === "'") return inner.replaceAll("''", "'");
  return inner.replace(/\\(["\\ntr])/g, (_, escaped) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' })[escaped]);
}

function parseScalar(raw, line) {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value[0] === '"' || value[0] === "'") return unquote(value, line);
  if (value.includes(' #')) fail(line, 'inline comments are not supported; quote the value instead');
  return value;
}

function parseInlineList(raw, line) {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => {
    const value = parseScalar(part, line);
    if (value === null) fail(line, 'empty item in inline list');
    return value;
  });
}

function splitKey(text, line) {
  const colon = text.indexOf(':');
  if (colon === -1) fail(line, `expected "key: value", got ${JSON.stringify(text)}`);
  const key = text.slice(0, colon).trim();
  if (!KEY_PATTERN.test(key)) fail(line, `invalid key ${JSON.stringify(key)}`);
  const rest = text.slice(colon + 1);
  if (rest !== '' && !rest.startsWith(' ')) fail(line, `key "${key}" needs a space after the colon`);
  return [key, rest.trim()];
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const result = {};
  let index = 0;

  const assign = (target, key, value, line) => {
    if (Object.hasOwn(target, key)) fail(line, `duplicate key "${key}"`);
    target[key] = value;
  };

  while (index < lines.length) {
    const raw = lines[index];
    const lineNumber = index + 1;
    index += 1;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (raw.startsWith(' ')) fail(lineNumber, 'unexpected indentation at the top level');

    const [key, inline] = splitKey(raw, lineNumber);

    if (inline.startsWith('[')) {
      if (!inline.endsWith(']')) fail(lineNumber, 'unterminated inline list');
      assign(result, key, parseInlineList(inline, lineNumber), lineNumber);
      continue;
    }
    if (inline !== '') {
      assign(result, key, parseScalar(inline, lineNumber), lineNumber);
      continue;
    }

    const block = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '') { index += 1; continue; }
      if (!next.startsWith('  ')) break;
      if (next.startsWith('   ') && !next.slice(2).trimStart().startsWith('#')) {
        fail(index + 1, 'nested blocks deeper than one level are not supported');
      }
      block.push([next.slice(2), index + 1]);
      index += 1;
    }

    if (block.length === 0) {
      assign(result, key, null, lineNumber);
      continue;
    }

    if (block[0][0].startsWith('- ')) {
      const items = block.map(([body, line]) => {
        if (!body.startsWith('- ')) fail(line, 'mixed list and map entries under the same key');
        const value = parseScalar(body.slice(2), line);
        if (value === null) fail(line, 'empty list item');
        return value;
      });
      assign(result, key, items, lineNumber);
      continue;
    }

    const map = {};
    for (const [body, line] of block) {
      if (body.startsWith('- ')) fail(line, 'mixed list and map entries under the same key');
      const [childKey, childValue] = splitKey(body, line);
      if (childValue.startsWith('[')) fail(line, 'nested inline lists are not supported');
      assign(map, childKey, parseScalar(childValue, line), line);
    }
    assign(result, key, map, lineNumber);
  }

  return result;
}

export function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) {
    throw new YamlError('missing opening "---" frontmatter delimiter');
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === DELIMITER);
  if (closing === -1) throw new YamlError('missing closing "---" frontmatter delimiter');
  return {
    data: parseYaml(lines.slice(1, closing).join('\n')),
    body: lines.slice(closing + 1).join('\n').trim(),
  };
}

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9 ._/+()-]*$/.test(text) && !text.endsWith(' ')
    ? text
    : JSON.stringify(text);
}

export function stringifyYaml(data) {
  const out = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out.push(`${key}: [${value.map(formatScalar).join(', ')}]`);
    } else if (value !== null && typeof value === 'object') {
      out.push(`${key}:`);
      for (const [childKey, childValue] of Object.entries(value)) {
        out.push(`  ${childKey}: ${formatScalar(childValue)}`);
      }
    } else {
      out.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return out.join('\n');
}
