#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

type HereDoc = {
  delimiter: string;
  stripTabs: boolean;
};

type Quote = 'single' | 'double' | null;

type Finding = {
  token: string;
  quoted: boolean;
};

const WINDOWS_PATH = /^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/;

function hereDocAt(command: string, index: number): { hereDoc: HereDoc; end: number } | null {
  let cursor = index + 2;
  const stripTabs = command[cursor] === '-';
  if (stripTabs) cursor += 1;
  while (command[cursor] === ' ' || command[cursor] === '\t') cursor += 1;

  const quote = command[cursor];
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    return { hereDoc: { delimiter: command.slice(cursor + 1, end), stripTabs }, end: end + 1 };
  }

  const match = command.slice(cursor).match(/^[^\s|&;()<>]+/);
  if (!match) return null;
  return { hereDoc: { delimiter: match[0], stripTabs }, end: cursor + match[0].length };
}

function skipHereDocBodies(command: string, index: number, hereDocs: HereDoc[]): number {
  let cursor = index;
  for (const { delimiter, stripTabs } of hereDocs) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf('\n', cursor);
      const end = lineEnd < 0 ? command.length : lineEnd;
      let line = command.slice(cursor, end).replace(/\r$/, '');
      if (stripTabs) line = line.replace(/^\t+/, '');
      cursor = lineEnd < 0 ? command.length : lineEnd + 1;
      if (line === delimiter) break;
    }
  }
  return cursor;
}

function escapedNewline(command: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function commentStart(command: string, index: number): boolean {
  if (command[index] !== '#') return false;
  const previous = command[index - 1];
  return previous === undefined || /[\s;&|(]/.test(previous);
}

// Double quotes keep a backslash literal except before $, `, ", \ or a newline,
// so only those shapes actually reach the shell as a different path.
function mangledInsideDoubleQuotes(command: string, token: string, index: number): boolean {
  if (/\\\$/.test(token)) return true;
  return token.endsWith('\\') && command[index + token.length] === '\n';
}

function windowsPath(command: string): Finding | null {
  let quote: Quote = null;
  let hereDocs: HereDoc[] = [];
  const substitutions: Quote[] = [];

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }

    if (character === '\n' && hereDocs.length > 0 && !escapedNewline(command, index)) {
      index = skipHereDocBodies(command, index + 1, hereDocs) - 1;
      hereDocs = [];
      continue;
    }

    // A command substitution reopens command context, heredocs and all, even
    // when it sits inside a double-quoted string.
    if (character === '$' && command[index + 1] === '(') {
      substitutions.push(quote);
      quote = null;
      index += 1;
      continue;
    }
    if (character === ')' && substitutions.length > 0) {
      quote = substitutions.pop() ?? null;
      continue;
    }

    if (quote === 'double') {
      const token = command.slice(index).match(WINDOWS_PATH)?.[0];
      if (token && mangledInsideDoubleQuotes(command, token, index)) return { token, quoted: true };
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (commentStart(command, index)) {
      const lineEnd = command.indexOf('\n', index);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
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
    if (character === '<' && command[index - 1] !== '<' && command[index + 1] === '<') {
      const parsed = hereDocAt(command, index);
      if (parsed) {
        hereDocs.push(parsed.hereDoc);
        index = parsed.end - 1;
        continue;
      }
    }

    const token = command.slice(index).match(WINDOWS_PATH)?.[0];
    if (token) return { token, quoted: false };
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
  const found = windowsPath(command);
  if (!found) return;
  writeDeny('PreToolUse', found.quoted
    ? `sidequest: double quotes eat the backslash in this Windows path (${found.token}) - a backslash before $ or a line break is not literal there; single-quote it or write it with forward slashes (C:/Users/...).`
    : `sidequest: unquoted Windows path in a POSIX shell (${found.token}) - backslashes are eaten and the path collapses into a literal filename in cwd; quote the path or write it with forward slashes (C:/Users/...).`);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
