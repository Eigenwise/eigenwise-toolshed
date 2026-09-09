'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCodexArtifactSchema } = require('../lib/tool-schema.js');
const pattern = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;

test('normalizes the exact Artifact pattern in nested schema branches only', () => {
  const tools = [{
    name: 'Artifact',
    input_schema: { anyOf: [{ properties: { name: { type: 'string', pattern } } }] },
  }, { name: 'OtherTool', input_schema: { type: 'string', pattern } }];
  const expected = structuredClone(tools);
  delete expected[0].input_schema.anyOf[0].properties.name.pattern;
  normalizeCodexArtifactSchema(tools);
  assert.deepEqual(tools, expected);
  normalizeCodexArtifactSchema(tools);
  assert.deepEqual(tools, expected);
});

test('retains other patterns and tolerates absent schemas and tools', () => {
  const tools = [null, { name: 'Artifact' }, {
    name: 'Artifact', input_schema: { pattern: `${pattern}$` },
  }];
  const expected = structuredClone(tools);
  normalizeCodexArtifactSchema(tools);
  assert.deepEqual(tools, expected);
  for (const value of [undefined, null, {}]) normalizeCodexArtifactSchema(value);
});
