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
  const recursive = /^(?:--recursive|-[a-z]*r[a-z]*|-recurse|\/s)$/i;
  return deleteArguments(command).some((argumentsAfterDelete) => (
    argumentsAfterDelete.replace(/["']/g, '').split(/\s+/).some((argument) => recursive.test(argument))
    && isProtectedPath(argumentsAfterDelete)
  ));
}

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[\\/]+$/, '');
}

const LEADING_HOME_REFERENCE = /^(?:~|\$home|\$env:userprofile|%userprofile%)(?=[\\/]|$)/i;
const HOME_REFERENCE = /\$home\b|\$env:userprofile\b|%userprofile%|(?<!\w)~(?=[\\/\s]|$)/i;

function deleteTargets(command: string): string[] {
  const home = os.homedir();
  return command.replace(/["']/g, '').split(/\s+/).map((target) => target.replace(LEADING_HOME_REFERENCE, () => home));
}

function isProtectedPath(command: string): boolean {
  const targets = deleteTargets(command);
  // A home reference anywhere but the start of a target cannot be resolved here, so it still blocks.
  if (HOME_REFERENCE.test(targets.join(' '))) return true;

  const home = path.resolve(os.homedir());
  const protectedRoots = [home, path.join(home, '.claude'), path.dirname(home), path.parse(home).root]
    .map(normalizePath);
  return targets
    .filter((target) => target !== '\\' && path.isAbsolute(target))
    .some((target) => {
      const resolved = path.resolve(target);
      if (path.parse(resolved).root === resolved) return true;
      const normalized = normalizePath(resolved);
      return protectedRoots.some((root) => root === normalized || root.startsWith(`${normalized}${path.sep}`));
    });
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
