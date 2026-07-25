import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonEditError, readValue, replaceValue } from '../lib/jsonedit.mjs';

const MANIFEST = `{
  "name": "eigenwise-toolshed",
  "owner": {
    "name": "Eigenwise",
    "version": "not the top level one"
  },
  "version": "3.207.0",
  "plugins": [
    {
      "name": "workbench",
      "version": "0.63.11",
      "keywords": ["a", "b"]
    },
    {
      "name": "sidequest",
      "version": "3.6.49",
      "description": "quotes \\" and braces {} and brackets [] inside a string"
    }
  ]
}
`;

test('reads values by path without confusing nested keys', () => {
  assert.equal(readValue(MANIFEST, ['version']), '3.207.0');
  assert.equal(readValue(MANIFEST, ['owner', 'version']), 'not the top level one');
  assert.equal(readValue(MANIFEST, ['plugins', 1, 'version']), '3.6.49');
  assert.equal(readValue(MANIFEST, ['plugins', 0, 'name']), 'workbench');
});

test('a replacement changes only the value bytes', () => {
  const updated = replaceValue(MANIFEST, ['plugins', 1, 'version'], '3.7.0');
  assert.equal(readValue(updated, ['plugins', 1, 'version']), '3.7.0');
  assert.equal(updated, MANIFEST.replace('"3.6.49"', '"3.7.0"'));
  assert.equal(readValue(updated, ['version']), '3.207.0');
  assert.equal(readValue(updated, ['owner', 'version']), 'not the top level one');
});

test('three fields move independently in one document', () => {
  let text = MANIFEST;
  text = replaceValue(text, ['version'], '3.208.0');
  text = replaceValue(text, ['plugins', 0, 'version'], '0.64.0');
  text = replaceValue(text, ['plugins', 1, 'version'], '3.7.0');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, '3.208.0');
  assert.equal(parsed.plugins[0].version, '0.64.0');
  assert.equal(parsed.plugins[1].version, '3.6.49'.replace('3.6.49', '3.7.0'));
  assert.equal(parsed.owner.version, 'not the top level one');
});

test('a missing path fails loudly instead of appending', () => {
  assert.throws(() => readValue(MANIFEST, ['nope']), JsonEditError);
  assert.throws(() => readValue(MANIFEST, ['plugins', 9, 'version']), /out of range/);
  assert.throws(() => readValue(MANIFEST, ['version', 'deeper']), /expected an object/);
});

test('survives compact and oddly spaced documents', () => {
  const compact = '{"version":"1.0.0","plugins":[{"name":"a","version":"2.0.0"}]}';
  assert.equal(readValue(compact, ['plugins', 0, 'version']), '2.0.0');
  assert.equal(replaceValue(compact, ['plugins', 0, 'version'], '2.0.1'), '{"version":"1.0.0","plugins":[{"name":"a","version":"2.0.1"}]}');

  const spaced = '{\n\t"version" :   "1.0.0"\n}';
  assert.equal(replaceValue(spaced, ['version'], '1.0.1'), '{\n\t"version" :   "1.0.1"\n}');
});
