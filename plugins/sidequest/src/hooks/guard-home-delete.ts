#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

function deleteArguments(command: string): string[] {
  const commands = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b([^;&|{}\n]*)/gi;
  return [...command.matchAll(commands)].map((match) => match[1] || '');
}

function hasProtectedRecursiveDelete(command: string): boolean {
  const recursive = /(?:--recursive\b|-[a-z]*r[a-z]*\b|-recurse\b|\/s\b)/i;
  return deleteArguments(command).some((argumentsAfterDelete) => recursive.test(argumentsAfterDelete) && isProtectedPath(argumentsAfterDelete));
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
  if (!hasProtectedRecursiveDelete(command)) return;
  writeDeny('PreToolUse', 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
