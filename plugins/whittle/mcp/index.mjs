#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { instructions, response } from './instructions.mjs';

const server = new McpServer({ name: 'whittle', version: '0.0.0' });

server.registerPrompt('whittle', {
  title: 'Whittle instructions',
  description: 'Return the Whittle clean-code policy. Persistence is unavailable.',
  argsSchema: {},
}, () => ({
  messages: [{ role: 'user', content: { type: 'text', text: instructions() } }],
}));

server.registerTool('whittle_instructions', {
  title: 'Whittle instructions',
  description: 'Return the Whittle clean-code policy with persistence:none.',
  inputSchema: {},
  outputSchema: { instructions: z.string(), persistence: z.literal('none') },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => {
  const result = response();
  return { content: [{ type: 'text', text: result.instructions }], structuredContent: result };
});

await server.connect(new StdioServerTransport());
