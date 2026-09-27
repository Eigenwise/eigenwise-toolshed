#!/usr/bin/env node
"use strict";
const mcp = require("../lib/mcp.js");
async function main() {
  const name = String(process.argv[2] || "").trim();
  if (!name) throw new Error("Usage: node sidequest-codex-call.js <MCP tool name> < JSON arguments");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Arguments exceed 64 KiB.");
  }
  const args = input.trim() ? JSON.parse(input) : {};
  const reply = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const result = reply?.result;
  if (!result?.content?.[0]?.text) throw new Error("Sidequest MCP returned no text result.");
  process.stdout.write(`${result.content[0].text}
`);
  if (result.isError) process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(`${error?.message || error}
`);
  process.exitCode = 1;
});
