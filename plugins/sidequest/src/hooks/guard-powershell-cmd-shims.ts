#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { writeContext } from './shared/output.js';

const COMMAND_SHIM = /\bstart-process\b[^\r\n;|]*\s-filepath\s+(?:"|')?(npm|npx|yarn|pnpm)(?:"|')?(?=\s|$)/i;

function main(): void {
  if (process.platform !== 'win32') return;
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'PowerShell') return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? String((toolInput as Record<string, unknown>).command || '')
    : '';
  const shim = command.match(COMMAND_SHIM)?.[1]?.toLowerCase();
  if (!shim) return;
  writeContext('PreToolUse', `sidequest: ${shim} is a .cmd shim on Windows, so Start-Process needs the shim explicitly. Use \`Start-Process -FilePath "${shim}.cmd" -ArgumentList "run","dev"\` or \`Start-Process -FilePath "cmd" -ArgumentList "/c","${shim}","run","dev"\`.`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
