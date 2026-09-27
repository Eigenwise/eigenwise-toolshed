'use strict';

// One MCP call per process. Codex launches this command in the calling agent's
// checkout, so Sidequest receives that agent's inherited CODEX_* identities;
// a desktop-wide MCP process can carry only its launcher's identity instead.
const mcp = require('../lib/mcp.js');

async function main() {
  const name = String(process.argv[2] || '').trim();
  if (!name) throw new Error('Usage: node sidequest-codex-call.js <MCP tool name> < JSON arguments');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Arguments exceed 64 KiB.');
  }
  const args = input.trim() ? JSON.parse(input) : {};
  const reply = await mcp.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = reply?.result;
  if (!result?.content?.[0]?.text) throw new Error('Sidequest MCP returned no text result.');
  process.stdout.write(`${result.content[0].text}\n`);
  if (result.isError) process.exitCode = 1;
}

main().catch((error: any) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
