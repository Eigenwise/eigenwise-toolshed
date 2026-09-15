'use strict';
/**
 * SQ-2 / GitHub #109: a property definition that itself carries `properties`
 * (i.e. describes an object) must also declare `type: 'object'`, or a host
 * that enforces the declared type (rather than inferring one from the
 * presence of `properties`) will refuse a top-level object argument even
 * though the runtime handler expects one. `integrate`'s verificationWaiver
 * was the reproducing case: nested under `wave` (which does declare
 * `type: 'object'`) it worked, but passed at the top level it did not.
 *
 * This walks every registered tool's inputSchema and asserts the invariant
 * holds everywhere, not just for the one property GitHub #109 named.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../lib/mcp.js');

function walkProperties(node: any, path: string, violations: string[]) {
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object') {
    if (node.type !== 'object') {
      violations.push(path);
    }
    for (const [key, child] of Object.entries(node.properties)) {
      walkProperties(child, `${path}.${key}`, violations);
    }
  }
  if (node.items) walkProperties(node.items, `${path}[]`, violations);
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch: any, i: number) => walkProperties(branch, `${path}<anyOf:${i}>`, violations));
  }
}

test('every registered tool property carrying properties also declares type: object', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = resp.result.tools;
  assert.ok(tools.length > 0, 'tools/list returned no tools');

  const violations: string[] = [];
  for (const tool of tools) {
    walkProperties(tool.inputSchema, tool.name, violations);
  }

  assert.deepEqual(violations, [], `properties without type: 'object': ${violations.join(', ')}`);
});
