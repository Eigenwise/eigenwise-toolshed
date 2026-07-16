#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function hasRecursiveDelete(command) {
  const deletes = /(?:^|[;&|\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|del)\b/i;
  const recursive = /(?:--recursive\b|-r(?:[fivd]*\b)?|-f[rivd]*\b|-recurse\b|\/s\b)/i;
  return deletes.test(command) && recursive.test(command);
}

function isProtectedPath(command) {
  if (/\$home\b|\$env:userprofile\b|%userprofile%|(?<!\w)~(?=[\\/\s"']|$)/i.test(command)) return true;

  const home = path.resolve(os.homedir());
  const protectedRoots = [home, path.join(home, '.claude'), path.dirname(home), path.parse(home).root]
    .map(normalizePath);
  return command
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter(path.isAbsolute)
    .map((target) => normalizePath(path.resolve(target)))
    .some((target) => protectedRoots.some((root) => root === target || root.startsWith(`${target}${path.sep}`)));
}

function normalizePath(value) {
  return value.toLowerCase().replace(/[\\/]+$/, '');
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') return;
  if (!['Bash', 'PowerShell'].includes(String(input.tool_name || ''))) return;

  const command = String(input.tool_input && input.tool_input.command || '');
  if (!hasRecursiveDelete(command) || !isProtectedPath(command)) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.',
    },
  }));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
