#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

function hasRecursiveDelete(command: string): boolean {
  const deletes = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b/i;
  const recursive = /(?:--recursive\b|-[a-z]*r[a-z]*\b|-recurse\b|\/s\b)/i;
  return deletes.test(command) && recursive.test(command);
}

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[\\/]+$/, '');
}

function isProtectedPath(command: string): boolean {
  if (/\$home\b|\$env:userprofile\b|%userprofile%|(?<!\w)~(?=[\\/\s"']|$)/i.test(command)) return true;

  const home = path.resolve(os.homedir());
  const protectedRoots = [home, path.join(home, '.claude'), path.dirname(home), path.parse(home).root]
    .map(normalizePath);
  return command
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter((target) => target !== '\\' && path.isAbsolute(target))
    .map((target) => normalizePath(path.resolve(target)))
    .some((target) => protectedRoots.some((root) => root === target || root.startsWith(`${target}${path.sep}`)));
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? String((toolInput as Record<string, unknown>).command || '')
    : '';
  if (!hasRecursiveDelete(command) || !isProtectedPath(command)) return;
  writeDeny('PreToolUse', 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
