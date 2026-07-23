#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

function unquotedWindowsPath(command: string): string | null {
  let quote: 'single' | 'double' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }

    const token = command.slice(index).match(/^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/)?.[0];
    if (token) return token;
  }

  return null;
}

function main(): void {
  if (process.platform !== 'win32') return;
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'Bash') return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? String((toolInput as Record<string, unknown>).command || '')
    : '';
  const token = unquotedWindowsPath(command);
  if (!token) return;
  writeDeny('PreToolUse', `sidequest: unquoted Windows path in a POSIX shell (${token}) - backslashes are eaten and the path collapses into a literal filename in cwd; quote the path or write it with forward slashes (C:/Users/...).`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
