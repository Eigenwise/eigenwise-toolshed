'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'mcp', 'index.mjs');

async function moduleAt(file) {
  return import(pathToFileURL(file).href + '?' + Date.now());
}

test('isolated SDK stdio exposes one parameterless readonly policy', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { instructions } = await moduleAt(path.join(root, 'mcp', 'instructions.mjs'));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whittle-mcp-home-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, WHITTLE_STATE_DIR: path.join(isolatedHome, 'state') },
  });
  const client = new Client({ name: 'whittle-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    const tool = await client.callTool({ name: 'whittle_instructions', arguments: {} });
    const prompt = await client.getPrompt({ name: 'whittle', arguments: {} });

    assert.deepEqual(tools.tools.map((item) => item.name), ['whittle_instructions']);
    assert.deepEqual(prompts.prompts.map((item) => item.name), ['whittle']);
    assert.equal(tool.structuredContent.persistence, 'none');
    assert.equal(tool.structuredContent.instructions, instructions());
    assert.equal(tool.content[0].text, instructions());
    assert.equal(prompt.messages[0].content.text, instructions());
  } finally {
    await client.close();
    assert.deepEqual(fs.readdirSync(isolatedHome), []);
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});
