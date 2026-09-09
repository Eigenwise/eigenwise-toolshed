'use strict';

const DRAFT_2020_12_URIS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
]);
const POSITIVE_SCHEMA_MAP_KEYWORDS = new Set(['properties', 'dependentSchemas']);
const POSITIVE_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'items',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
const POSITIVE_SCHEMA_ARRAY_KEYWORDS = new Set(['prefixItems', 'allOf', 'anyOf']);
const FORBIDDEN_SCHEMA_KEYWORDS = new Set([
  '$defs', '$ref', '$dynamicRef', '$recursiveRef', 'definitions', 'not', 'if', 'then', 'else',
  'oneOf', 'contains', 'contentSchema',
]);
const REFERENCE_OR_ANCHOR_KEYWORDS = new Set([
  '$id', '$ref', '$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor', '$recursiveAnchor',
]);
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples', 'description']);
const KNOWN_NON_CONTAINER_KEYWORDS = new Set([
  '$schema', '$vocabulary', '$comment', 'title', 'deprecated', 'readOnly', 'writeOnly', 'format',
  'contentEncoding', 'contentMediaType', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum',
  'exclusiveMinimum', 'maxLength', 'minLength', 'maxItems', 'minItems', 'uniqueItems', 'maxContains',
  'minContains', 'maxProperties', 'minProperties', 'required', 'dependentRequired', 'pattern',
  'patternProperties', 'type',
]);

class ToolSchemaCompatibilityError extends Error {
  constructor({ toolName = '<unnamed tool>', pointer, reasonCode }) {
    super(`Codex schema compatibility refused ${toolName} at ${pointer} (${reasonCode})`);
    this.name = 'ToolSchemaCompatibilityError';
    this.toolName = toolName;
    this.pointer = pointer;
    this.reasonCode = reasonCode;
  }
}

function isSchemaObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function appendJsonPointer(pointer, segment) {
  return `${pointer}/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function compatibilityError(pointer, reasonCode) {
  throw new ToolSchemaCompatibilityError({ pointer, reasonCode });
}

const ACCEPTED_REGEX_ESCAPE_TOKEN_KINDS = new Set([
  'escaped-punctuation',
  'character-class-shorthand',
  'word-boundary-or-backspace',
  'control-whitespace',
  'hexadecimal-code-unit',
  'unicode-code-point',
  'control-character',
  'null-character',
  'unicode-property',
]);
const SIMPLE_REGEX_ESCAPE_KINDS = new Map([
  ['d', 'character-class-shorthand'], ['D', 'character-class-shorthand'],
  ['s', 'character-class-shorthand'], ['S', 'character-class-shorthand'],
  ['w', 'character-class-shorthand'], ['W', 'character-class-shorthand'],
  ['b', 'word-boundary-or-backspace'], ['B', 'word-boundary-or-backspace'],
  ['f', 'control-whitespace'], ['n', 'control-whitespace'], ['r', 'control-whitespace'],
  ['t', 'control-whitespace'], ['v', 'control-whitespace'],
]);
const ESCAPED_REGEX_PUNCTUATION = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/', '-']);

function readRegexEscape(pattern, start) {
  const escapedCharacter = pattern[start + 1];
  if (escapedCharacter === undefined) return { kind: 'malformed-escape', end: start + 1 };
  if (escapedCharacter === 'p' || escapedCharacter === 'P') {
    if (pattern[start + 2] !== '{') return { kind: 'malformed-unicode-property', end: start + 2 };
    const closeBrace = pattern.indexOf('}', start + 3);
    if (closeBrace === -1 || closeBrace === start + 3) {
      return { kind: 'malformed-unicode-property', end: pattern.length };
    }
    return { kind: 'unicode-property', start, end: closeBrace + 1 };
  }
  if (/[1-9]/u.test(escapedCharacter)) return { kind: 'backreference', end: start + 2 };
  if (escapedCharacter === 'k') return { kind: 'backreference', end: start + 2 };
  if (escapedCharacter === '0') return { kind: 'null-character', end: start + 2 };
  if (escapedCharacter === 'x') {
    const digits = pattern.slice(start + 2, start + 4);
    return /^[0-9a-f]{2}$/iu.test(digits)
      ? { kind: 'hexadecimal-code-unit', end: start + 4 }
      : { kind: 'malformed-escape', end: start + 2 };
  }
  if (escapedCharacter === 'u') {
    if (pattern[start + 2] === '{') {
      const closeBrace = pattern.indexOf('}', start + 3);
      const digits = closeBrace === -1 ? '' : pattern.slice(start + 3, closeBrace);
      return closeBrace !== -1 && /^[0-9a-f]{1,6}$/iu.test(digits)
        ? { kind: 'unicode-code-point', end: closeBrace + 1 }
        : { kind: 'malformed-escape', end: start + 2 };
    }
    const digits = pattern.slice(start + 2, start + 6);
    return /^[0-9a-f]{4}$/iu.test(digits)
      ? { kind: 'unicode-code-point', end: start + 6 }
      : { kind: 'malformed-escape', end: start + 2 };
  }
  if (escapedCharacter === 'c') {
    return /^[A-Z]$/iu.test(pattern[start + 2] || '')
      ? { kind: 'control-character', end: start + 3 }
      : { kind: 'malformed-escape', end: start + 2 };
  }
  if (SIMPLE_REGEX_ESCAPE_KINDS.has(escapedCharacter)) {
    return { kind: SIMPLE_REGEX_ESCAPE_KINDS.get(escapedCharacter), end: start + 2 };
  }
  if (ESCAPED_REGEX_PUNCTUATION.has(escapedCharacter)) return { kind: 'escaped-punctuation', end: start + 2 };
  return { kind: 'unsupported-regex-escape', end: start + 2 };
}

function assertAcceptedRegexEscape(token, pointer) {
  if (token.kind === 'backreference') compatibilityError(pointer, 'backreference-or-unsupported-escape');
  if (token.kind === 'malformed-unicode-property') compatibilityError(pointer, 'malformed-unicode-property');
  if (token.kind === 'malformed-escape') compatibilityError(pointer, 'invalid-regex');
  if (token.kind === 'unsupported-regex-escape') compatibilityError(pointer, 'unsupported-regex-escape');
  if (!ACCEPTED_REGEX_ESCAPE_TOKEN_KINDS.has(token.kind)) compatibilityError(pointer, 'invalid-regex');
}

function containsPotentialUnicodePropertyEscape(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') {
      index += 1;
      continue;
    }
    const token = readRegexEscape(value, index);
    if (token.kind === 'unicode-property' || token.kind === 'malformed-unicode-property') return true;
    index = token.end;
  }
  return false;
}

function scanCharacterClass(pattern, start, pointer) {
  const negated = pattern[start + 1] === '^';
  const contentStart = start + (negated ? 2 : 1);
  const propertySpans = [];
  let index = contentStart;
  let closed = false;
  let hasRangeOrSetSyntax = false;

  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '\\') {
      const token = readRegexEscape(pattern, index);
      assertAcceptedRegexEscape(token, pointer);
      if (token.kind === 'unicode-property') propertySpans.push(token);
      index = token.end;
      continue;
    }
    if (character === ']') {
      closed = true;
      break;
    }
    if (character === '-' || (character === '&' && pattern[index + 1] === '&')) hasRangeOrSetSyntax = true;
    index += 1;
  }

  if (!closed) compatibilityError(pointer, 'invalid-regex');
  if (propertySpans.length === 0) return { end: index + 1, replacement: null };
  if (!negated) compatibilityError(pointer, 'positive-character-class');
  if (hasRangeOrSetSyntax || pattern.slice(contentStart, index).includes('--')) {
    compatibilityError(pointer, 'range-or-set-character-class');
  }

  let replacement = '';
  let cursor = contentStart;
  for (const property of propertySpans) {
    replacement += pattern.slice(cursor, property.start);
    cursor = property.end;
  }
  replacement += pattern.slice(cursor, index);
  if (replacement.length === 0) compatibilityError(pointer, 'empty-negated-character-class');

  return { end: index + 1, replacement: `${negated ? '^' : ''}${replacement}`, propertySpans };
}

function readRegexGroup(pattern, start, pointer) {
  const groupPrefix = pattern.slice(start, start + 4);
  if (groupPrefix.startsWith('(?!') || groupPrefix.startsWith('(?<!')) return { context: 'negative', end: start + (groupPrefix.startsWith('(?<!') ? 4 : 3) };
  if (groupPrefix.startsWith('(?:') || groupPrefix.startsWith('(?=') || groupPrefix.startsWith('(?<=')) {
    return { context: 'positive', end: start + (groupPrefix.startsWith('(?<=') ? 4 : 3) };
  }
  compatibilityError(pointer, 'capture-or-unsupported-group');
}

function validateRegexGrammar(pattern, pointer) {
  const replacements = [];
  const groupContexts = [];
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === '\\') {
      const token = readRegexEscape(pattern, index);
      assertAcceptedRegexEscape(token, pointer);
      if (token.kind === 'unicode-property') compatibilityError(pointer, 'property-outside-negated-character-class');
      index = token.end;
      continue;
    }
    if (character === '[') {
      const characterClass = scanCharacterClass(pattern, index, pointer);
      if (characterClass.propertySpans?.length && groupContexts.includes('negative')) {
        compatibilityError(pointer, 'negative-regex-context');
      }
      if (characterClass.replacement !== null) {
        replacements.push({ start: index, end: characterClass.end, replacement: `[${characterClass.replacement}]` });
      }
      index = characterClass.end;
      continue;
    }
    if (character === '(') {
      const group = readRegexGroup(pattern, index, pointer);
      groupContexts.push(group.context);
      index = group.end;
      continue;
    }
    if (character === ')') {
      groupContexts.pop();
      index += 1;
      continue;
    }
    index += 1;
  }

  try {
    new RegExp(pattern, 'u');
  } catch {
    compatibilityError(pointer, 'invalid-regex');
  }

  if (replacements.length === 0) return null;
  let adapted = '';
  let cursor = 0;
  for (const replacement of replacements) {
    adapted += pattern.slice(cursor, replacement.start);
    adapted += replacement.replacement;
    cursor = replacement.end;
  }
  return `${adapted}${pattern.slice(cursor)}`;
}

function findAffectedPattern(value, pointer, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.pattern === 'string' && containsPotentialUnicodePropertyEscape(value.pattern)) return pointer;
  if (isSchemaObject(value.patternProperties)
    && Object.keys(value.patternProperties).some(containsPotentialUnicodePropertyEscape)) return pointer;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (DATA_KEYWORDS.has(key)) continue;
    const nestedPointer = findAffectedPattern(nestedValue, appendJsonPointer(pointer, key), seen);
    if (nestedPointer) return nestedPointer;
  }
  return null;
}

function classifySchema(schema, rootPointer = '/input_schema') {
  const affectedPointer = findAffectedPattern(schema, rootPointer);
  if (!affectedPointer) return { changed: false, replacements: [] };
  if (!isSchemaObject(schema)) compatibilityError(rootPointer, 'invalid-schema');

  const replacements = [];
  visitSchema(schema, rootPointer, replacements);
  return { changed: replacements.length > 0, replacements };
}

function visitSchema(schema, pointer, replacements) {
  if (schema === true || schema === false) return;
  if (!isSchemaObject(schema)) compatibilityError(pointer, 'invalid-schema-container');

  for (const [keyword, value] of Object.entries(schema)) {
    const keywordPointer = appendJsonPointer(pointer, keyword);
    if (keyword === '$schema') {
      if (typeof value !== 'string' || !DRAFT_2020_12_URIS.has(value)) compatibilityError(keywordPointer, 'unsupported-dialect');
      continue;
    }
    if (keyword === '$vocabulary') compatibilityError(keywordPointer, 'custom-vocabulary');
    if (REFERENCE_OR_ANCHOR_KEYWORDS.has(keyword)) compatibilityError(keywordPointer, 'reference-or-anchor-keyword');
    if (FORBIDDEN_SCHEMA_KEYWORDS.has(keyword)) compatibilityError(keywordPointer, 'forbidden-schema-applicator');
    if (keyword === 'pattern') {
      if (typeof value !== 'string' || !containsPotentialUnicodePropertyEscape(value)) continue;
      const replacement = validateRegexGrammar(value, keywordPointer);
      if (replacement !== null) replacements.push({ pointer: keywordPointer, replacement });
      continue;
    }
    if (keyword === 'patternProperties') {
      visitPatternProperties(value, keywordPointer, replacements);
      continue;
    }
    if (POSITIVE_SCHEMA_MAP_KEYWORDS.has(keyword)) {
      visitSchemaMap(value, keywordPointer, replacements);
      continue;
    }
    if (POSITIVE_SCHEMA_KEYWORDS.has(keyword)) {
      visitSchema(value, keywordPointer, replacements);
      continue;
    }
    if (POSITIVE_SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
      visitSchemaArray(value, keywordPointer, replacements);
      continue;
    }
    if (DATA_KEYWORDS.has(keyword) || KNOWN_NON_CONTAINER_KEYWORDS.has(keyword)) continue;
    if (findAffectedPattern(value, keywordPointer)) compatibilityError(keywordPointer, 'unknown-schema-container');
  }
}

function visitSchemaMap(value, pointer, replacements) {
  if (!isSchemaObject(value)) {
    if (findAffectedPattern(value, pointer)) compatibilityError(pointer, 'invalid-schema-container');
    return;
  }
  for (const [name, childSchema] of Object.entries(value)) visitSchema(childSchema, appendJsonPointer(pointer, name), replacements);
}

function visitPatternProperties(value, pointer, replacements) {
  if (!isSchemaObject(value)) {
    if (findAffectedPattern(value, pointer)) compatibilityError(pointer, 'invalid-schema-container');
    return;
  }
  for (const [pattern, childSchema] of Object.entries(value)) {
    if (containsPotentialUnicodePropertyEscape(pattern)) compatibilityError(pointer, 'affected-pattern-properties-key');
    visitSchema(childSchema, appendJsonPointer(pointer, pattern), replacements);
  }
}

function visitSchemaArray(value, pointer, replacements) {
  if (!Array.isArray(value)) {
    if (findAffectedPattern(value, pointer)) compatibilityError(pointer, 'invalid-schema-container');
    return;
  }
  for (const [index, childSchema] of value.entries()) visitSchema(childSchema, appendJsonPointer(pointer, index), replacements);
}

function setAtJsonPointer(target, pointer, value) {
  const segments = pointer.split('/').slice(2).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const key = segments.pop();
  let parent = target;
  for (const segment of segments) parent = parent[segment];
  parent[key] = value;
}

function adaptCodexInputSchema(inputSchema) {
  const classification = classifySchema(inputSchema);
  if (!classification.changed) return inputSchema;
  const adaptedSchema = structuredClone(inputSchema);
  for (const replacement of classification.replacements) setAtJsonPointer(adaptedSchema, replacement.pointer, replacement.replacement);
  return adaptedSchema;
}

function adaptCodexToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  const classifications = tools.map((tool, index) => {
    if (!isSchemaObject(tool) || !Object.hasOwn(tool, 'input_schema')) return null;
    try {
      return classifySchema(tool.input_schema, `/tools/${index}/input_schema`);
    } catch (error) {
      if (error instanceof ToolSchemaCompatibilityError) {
        error.toolName = typeof tool.name === 'string' ? tool.name : '<unnamed tool>';
        error.message = `Codex schema compatibility refused ${error.toolName} at ${error.pointer} (${error.reasonCode})`;
      }
      throw error;
    }
  });
  if (!classifications.some((classification) => classification?.changed)) return tools;
  return tools.map((tool, index) => {
    const classification = classifications[index];
    if (!classification?.changed) return tool;
    const adaptedSchema = structuredClone(tool.input_schema);
    for (const replacement of classification.replacements) {
      setAtJsonPointer(adaptedSchema, replacement.pointer.replace(`/tools/${index}`, ''), replacement.replacement);
    }
    return { ...tool, input_schema: adaptedSchema };
  });
}

module.exports = {
  ACCEPTED_REGEX_ESCAPE_TOKEN_KINDS,
  ToolSchemaCompatibilityError,
  adaptCodexInputSchema,
  adaptCodexToolSchemas,
  containsPotentialUnicodePropertyEscape,
};
