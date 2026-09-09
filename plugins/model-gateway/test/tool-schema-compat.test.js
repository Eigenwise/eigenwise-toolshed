'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveSuite } = require('../../sidequest/lib/suite-resolver.js');
const Ajv2020 = require('ajv/dist/2020.js');
const {
  ACCEPTED_REGEX_ESCAPE_TOKEN_KINDS,
  ToolSchemaCompatibilityError,
  adaptCodexInputSchema,
  adaptCodexToolSchemas,
  containsPotentialUnicodePropertyEscape,
} = require('../lib/tool-schema-compat.js');

const ARTIFACT_PATTERN = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;
const ARTIFACT_OUTPUT = String.raw`^(?!__.*__$)[^"\\./[\]]{1,200}$`;
const PROPERTY_PATTERN = String.raw`[^\p{Cc}a]`;

function compile(schema) {
  return new Ajv2020({ strict: false, unicodeRegExp: true }).compile(schema);
}

const priorAdapterDirectory = path.join(__dirname, 'fixtures', 'prior-adapters');
const priorAdapterSnapshots = require('./fixtures/prior-adapters/snapshots.json');

function loadPriorAdapter(snapshotName) {
  const snapshot = priorAdapterSnapshots[snapshotName];
  const snapshotPath = path.join(priorAdapterDirectory, `${snapshotName}-tool-schema-compat.js`);
  const source = readFileSync(snapshotPath);
  assert.equal(createHash('sha256').update(source).digest('hex'), snapshot.sha256, `${snapshot.source} digest`);
  return require(snapshotPath);
}

function schemaWithPattern(pattern = PROPERTY_PATTERN) {
  return { type: 'string', pattern };
}

function tool(schema, name = 'artifact_tool') {
  return { name, description: 'synthetic fixture', input_schema: schema };
}

function refusal(schema, reasonCode) {
  assert.throws(() => adaptCodexToolSchemas([tool(schema)]), (error) => {
    assert.ok(error instanceof ToolSchemaCompatibilityError);
    assert.equal(error.toolName, 'artifact_tool');
    assert.match(error.pointer, /^\/tools\/0\/input_schema/);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function adaptedPattern(schema) {
  return adaptCodexInputSchema(schema).pattern;
}

function positiveApplicatorSchemas() {
  return [
    schemaWithPattern(),
    { properties: { value: schemaWithPattern() } },
    { patternProperties: { '^x-': schemaWithPattern() } },
    { additionalProperties: schemaWithPattern() },
    { items: schemaWithPattern() },
    { prefixItems: [schemaWithPattern()] },
    { allOf: [schemaWithPattern()] },
    { anyOf: [schemaWithPattern()] },
    { dependentSchemas: { enabled: schemaWithPattern() } },
    { propertyNames: schemaWithPattern() },
    { unevaluatedProperties: schemaWithPattern() },
    { unevaluatedItems: schemaWithPattern() },
  ];
}

function findPattern(schema) {
  if (typeof schema.pattern === 'string') return schema.pattern;
  for (const value of Object.values(schema)) {
    if (value && typeof value === 'object') {
      const found = Array.isArray(value)
        ? value.map(findPattern).find(Boolean)
        : findPattern(value);
      if (found) return found;
    }
  }
  return undefined;
}

test('uses Ajv 8.20.0 as the conforming Draft 2020-12 oracle', () => {
  const packageVersion = require('../node_modules/ajv/package.json').version;
  assert.equal(packageVersion, '8.20.0');
  assert.equal(typeof Ajv2020, 'function');
});

test('uses the shared suite resolver package-script convention for cold gateway setup', () => {
  const suite = resolveSuite(path.resolve(__dirname, '../../..'), {
    name: 'model-gateway',
    dir: 'plugins/model-gateway',
  });
  assert.deepEqual(suite, {
    plugin: 'model-gateway',
    cwd: 'plugins/model-gateway',
    setup: 'npm ci',
    command: 'npm test',
  });
});

test('rewrites only the approved Artifact property atoms and retains the provider-accepted grammar', () => {
  const original = schemaWithPattern(ARTIFACT_PATTERN);
  const originalSnapshot = structuredClone(original);
  const adapted = adaptCodexInputSchema(original);

  assert.equal(adapted.pattern, ARTIFACT_OUTPUT);
  assert.deepEqual(original, originalSnapshot);
  assert.equal(compile(original)('safe_name'), true);
  assert.equal(compile(adapted)('safe_name'), true);
  assert.equal(compile(original)('bad/name'), false);
  assert.equal(compile(adapted)('bad/name'), false);
  assert.equal(compile(original)('\u0000'), false);
  assert.equal(compile(adapted)('\u0000'), true);
});

test('accepts only the listed positive schema applicators and preserves supported unevaluated semantics', () => {
  for (const schema of positiveApplicatorSchemas()) {
    assert.equal(findPattern(adaptCodexInputSchema(schema)), '[^a]');
  }

  const original = {
    type: 'object',
    allOf: [{ properties: { filename: schemaWithPattern(ARTIFACT_PATTERN) } }],
    unevaluatedProperties: false,
  };
  const adapted = adaptCodexInputSchema(original);
  assert.equal(compile(original)({ filename: 'safe_name' }), true);
  assert.equal(compile(adapted)({ filename: 'safe_name' }), true);
  assert.equal(compile(adapted)({ filename: 'safe_name', extra: 'nope' }), false);

  const arrayOriginal = {
    type: 'array',
    prefixItems: [schemaWithPattern(ARTIFACT_PATTERN)],
    unevaluatedItems: false,
  };
  const arrayAdapted = adaptCodexInputSchema(arrayOriginal);
  assert.equal(compile(arrayOriginal)(['safe_name']), true);
  assert.equal(compile(arrayAdapted)(['safe_name']), true);
  assert.equal(compile(arrayAdapted)(['safe_name', 'extra']), false);
});

test('keeps unaffected schemas, cycles, and data-valued annotations exact', () => {
  const unaffected = {
    type: 'object',
    description: String.raw`data says \p{Cc}`,
    default: { pattern: String.raw`\p{Cc}` },
    examples: [{ pattern: String.raw`\P{Cf}` }],
    properties: { literal: { type: 'string', pattern: String.raw`^\\p{Cc}$` } },
  };
  const selfReference = { type: 'object' };
  selfReference.self = selfReference;

  const referenceCycle = {
    $defs: { node: { $ref: '#/$defs/node' } },
    $ref: '#/$defs/node',
  };

  assert.strictEqual(adaptCodexInputSchema(unaffected), unaffected);
  assert.strictEqual(adaptCodexInputSchema(selfReference), selfReference);
  assert.strictEqual(adaptCodexInputSchema(referenceCycle), referenceCycle);
  assert.equal(containsPotentialUnicodePropertyEscape(String.raw`^\\p{Cc}$`), false);
  assert.equal(containsPotentialUnicodePropertyEscape(String.raw`\p{Cc}`), true);
});

test('honors odd escape parity while leaving escaped literal property text byte-identical', () => {
  const oneSlash = schemaWithPattern(String.raw`[^\p{Cc}a]`);
  const threeSlashes = schemaWithPattern(String.raw`[^\\\p{Cc}a]`);
  const twoSlashes = schemaWithPattern(String.raw`[^\\p{Cc}a]`);
  const fourSlashes = schemaWithPattern(String.raw`[^\\\\p{Cc}a]`);

  assert.equal(adaptedPattern(oneSlash), '[^a]');
  assert.equal(adaptedPattern(threeSlashes), String.raw`[^\\a]`);
  assert.strictEqual(adaptCodexInputSchema(twoSlashes), twoSlashes);
  assert.strictEqual(adaptCodexInputSchema(fourSlashes), fourSlashes);
});

test('refuses every unsupported schema composition before it can lose evaluation annotations', () => {
  const unsupported = [
    [{ not: schemaWithPattern() }, 'forbidden-schema-applicator'],
    [{ if: schemaWithPattern(), then: { type: 'string' } }, 'forbidden-schema-applicator'],
    [{ oneOf: [schemaWithPattern()] }, 'forbidden-schema-applicator'],
    [{ contains: schemaWithPattern() }, 'forbidden-schema-applicator'],
    [{ $defs: { value: schemaWithPattern() } }, 'forbidden-schema-applicator'],
    [{ definitions: { value: schemaWithPattern() } }, 'forbidden-schema-applicator'],
    [{ $ref: '#/anything', properties: { value: schemaWithPattern() } }, 'reference-or-anchor-keyword'],
    [{ contentSchema: schemaWithPattern() }, 'forbidden-schema-applicator'],
    [{ customApplicator: schemaWithPattern() }, 'unknown-schema-container'],
    [{ $schema: 'https://json-schema.org/draft/2019-09/schema', properties: { value: schemaWithPattern() } }, 'unsupported-dialect'],
    [{ $anchor: 'root', properties: { value: schemaWithPattern() } }, 'reference-or-anchor-keyword'],
    [{ $vocabulary: {}, properties: { value: schemaWithPattern() } }, 'custom-vocabulary'],
  ];
  for (const [schema, reasonCode] of unsupported) refusal(schema, reasonCode);
});

test('refuses the prior conditional, oneOf, and annotation counterexamples with Ajv-accepted inputs', () => {
  const cases = [
    {
      schema: {
        if: { required: ['kind'], properties: { kind: { const: 'control' } } },
        else: { properties: { fallback: schemaWithPattern() } },
        unevaluatedProperties: false,
      },
      value: { fallback: 'plain' },
    },
    {
      schema: {
        allOf: [{ patternProperties: { '^x-': schemaWithPattern() } }],
        unevaluatedProperties: false,
      },
      value: { 'x-value': 'plain' },
      supported: true,
    },
    {
      schema: {
        $defs: { branch: { if: { required: ['kind'], properties: { kind: { const: 'control' } } }, else: { properties: { fallback: schemaWithPattern() } } } },
        $ref: '#/$defs/branch',
        unevaluatedProperties: false,
      },
      value: { fallback: 'plain' },
    },
    {
      schema: {
        patternProperties: { [String.raw`^x-\p{Cc}$`]: { type: 'string' } },
        additionalProperties: false,
      },
      value: { 'x-\u0000': 'plain' },
    },
    {
      schema: {
        if: { type: 'object', properties: { kind: { const: 'control' } } },
        else: { prefixItems: [schemaWithPattern()] },
        unevaluatedItems: false,
      },
      value: ['plain'],
    },
  ];
  for (const [index, { schema, value, supported }] of cases.entries()) {
    assert.equal(compile(schema)(value), true, `case ${index} is accepted before adaptation`);
    if (supported) {
      assert.equal(compile(adaptCodexInputSchema(schema))(value), true);
    } else {
      assert.throws(() => adaptCodexInputSchema(schema), ToolSchemaCompatibilityError);
    }
  }
});

test('executes immutable prior adapter snapshots against real SQ-2551 and SQ-2561 Ajv counterexamples', () => {
  const firstAdapter = loadPriorAdapter('20ef3d38');
  const secondAdapter = loadPriorAdapter('d68e8ec5');
  const firstCounterexamples = [
    [{ not: schemaWithPattern(String.raw`\p{Cc}`) }, 'a'],
    [{ if: schemaWithPattern(String.raw`\p{Cc}`), then: { const: 'control' }, else: { const: 'plain' } }, 'plain'],
    [{ oneOf: [schemaWithPattern(String.raw`\p{Cc}`), { type: 'string' }] }, 'a'],
  ];

  for (const [schema, value] of firstCounterexamples) {
    assert.equal(compile(schema)(value), true);
    assert.equal(compile(firstAdapter.adaptCodexInputSchema(schema))(value), false);
  }

  const elseOnlyFixture = {
    if: { required: ['kind'], properties: { kind: { const: 'control' } } },
    else: { properties: { fallback: schemaWithPattern() } },
    unevaluatedProperties: false,
  };
  assert.equal(compile(elseOnlyFixture)({ fallback: 'plain' }), true);
  assert.equal(compile(secondAdapter.adaptCodexInputSchema(elseOnlyFixture))({ fallback: 'plain' }), true);

  const secondCounterexample = {
    allOf: [{ patternProperties: { [String.raw`^x-\p{Cc}$`]: { type: 'string' } } }],
    unevaluatedProperties: false,
  };
  const secondCounterexampleValue = { 'x- ': 'plain' };
  assert.equal(compile(secondCounterexample)(secondCounterexampleValue), true);
  assert.equal(compile(secondAdapter.adaptCodexInputSchema(secondCounterexample))(secondCounterexampleValue), false);
});

test('pins accepted lexical escape token kinds and consumes escaped structural punctuation atomically', () => {
  assert.deepEqual([...ACCEPTED_REGEX_ESCAPE_TOKEN_KINDS].sort(), [
    'character-class-shorthand',
    'control-character',
    'control-whitespace',
    'escaped-punctuation',
    'hexadecimal-code-unit',
    'null-character',
    'unicode-code-point',
    'unicode-property',
    'word-boundary-or-backspace',
  ]);

  const positiveCases = [
    [String.raw`^(?:\([^\p{Cc}\(\)\[\]\\a]\))$`, String.raw`^(?:\([^\(\)\[\]\\a]\))$`],
    [String.raw`^(?=\[[^\p{Cc}\[\]a]\]$).*$`, String.raw`^(?=\[[^\[\]a]\]$).*$`],
    [String.raw`^(?<=\)[^\p{Cc}a]).*$`, String.raw`^(?<=\)[^a]).*$`],
    [String.raw`^(?:(?:[^\\\p{Cc}a]))$`, String.raw`^(?:(?:[^\\a]))$`],
  ];
  for (const [pattern, expected] of positiveCases) assert.equal(adaptedPattern(schemaWithPattern(pattern)), expected);

  const exactNegativeLookahead = schemaWithPattern(String.raw`^(?!\)[^\p{Cc}X]).*$`);
  const exactInput = `${String.fromCodePoint(41)}${String.fromCodePoint(0)}`;
  assert.deepEqual([...exactInput].map((character) => character.codePointAt(0)), [41, 0]);
  assert.doesNotThrow(() => new RegExp(exactNegativeLookahead.pattern, 'u'));
  assert.equal(compile(exactNegativeLookahead)(exactInput), true);
  refusal(exactNegativeLookahead, 'negative-regex-context');

  const negativeCases = [
    String.raw`^(?!\[[^\p{Cc}\[\]X]\]).*$`,
    String.raw`^(?![^\p{Cc}\(\)\[\]\\X]).*$`,
    String.raw`^(?<!\)[^\p{Cc}X]).*$`,
    String.raw`^(?:(?![^\\\p{Cc}X]))$`,
  ];
  for (const pattern of negativeCases) {
    assert.doesNotThrow(() => new RegExp(pattern, 'u'));
    refusal(schemaWithPattern(pattern), 'negative-regex-context');
  }

  const evenEscapes = [
    String.raw`(?:[^\\p{Cc}a])`,
    String.raw`(?!(?:[^\\p{Cc}a]))`,
  ];
  for (const pattern of evenEscapes) assert.strictEqual(adaptCodexInputSchema(schemaWithPattern(pattern)).pattern, pattern);
});

test('refuses unsafe regex contexts and malformed character classes', () => {
  const cases = [
    [schemaWithPattern(String.raw`\p{Cc}`), 'property-outside-negated-character-class'],
    [schemaWithPattern(String.raw`[\p{Cc}a]`), 'positive-character-class'],
    [schemaWithPattern(String.raw`[^\p{Cc}]`), 'empty-negated-character-class'],
    [schemaWithPattern(String.raw`[^\p{Cc}-a]`), 'range-or-set-character-class'],
    [schemaWithPattern(String.raw`(?!(?:[^\p{Cc}a]))a`), 'negative-regex-context'],
    [schemaWithPattern(String.raw`([^\p{Cc}a])`), 'capture-or-unsupported-group'],
    [schemaWithPattern(String.raw`(?:[^\p{Cc}a])\1`), 'backreference-or-unsupported-escape'],
    [schemaWithPattern(String.raw`[^\q\p{Cc}a]`), 'unsupported-regex-escape'],
    [schemaWithPattern(String.raw`[^\u12\p{Cc}a]`), 'invalid-regex'],
    [schemaWithPattern(String.raw`[^\p]`), 'malformed-unicode-property'],
  ];
  for (const [schema, reasonCode] of cases) refusal(schema, reasonCode);
});

test('does not inspect unrelated sibling regex grammar after finding an affected pattern', () => {
  const schema = {
    type: 'object',
    properties: {
      filename: schemaWithPattern(ARTIFACT_PATTERN),
      repeated: { type: 'string', pattern: String.raw`([a-z])\1` },
    },
  };
  const adapted = adaptCodexInputSchema(schema);
  assert.equal(adapted.properties.filename.pattern, ARTIFACT_OUTPUT);
  assert.equal(adapted.properties.repeated.pattern, String.raw`([a-z])\1`);
});

test('classifies the complete array before cloning and never changes unaffected sibling tools', () => {
  const affected = tool(schemaWithPattern(ARTIFACT_PATTERN), 'affected');
  const unaffected = tool(schemaWithPattern('^[a-z]+$'), 'unaffected');
  const originalTools = [unaffected, affected];
  const originalSnapshot = structuredClone(originalTools);
  const adapted = adaptCodexToolSchemas(originalTools);

  assert.notStrictEqual(adapted, originalTools);
  assert.strictEqual(adapted[0], unaffected);
  assert.notStrictEqual(adapted[1], affected);
  assert.equal(adapted[1].input_schema.pattern, ARTIFACT_OUTPUT);
  assert.deepEqual(originalTools, originalSnapshot);

  const unsafe = tool({ not: schemaWithPattern() }, 'unsafe');
  assert.throws(() => adaptCodexToolSchemas([affected, unsafe]), ToolSchemaCompatibilityError);
  assert.deepEqual(affected, originalSnapshot[1]);
});
