#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function hasRecursiveDelete(command) {
  // {}() must anchor too: the 2026-07-16 wipe wrapped its Remove-Item in
  // `if (...) { ... }`, which a start/;&| anchor never sees.
  const deletes = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b/i;
  const recursive = /(?:--recursive\b|-[a-z]*r[a-z]*\b|-recurse\b|\/s\b)/i;
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
    // A lone backslash is a shell line continuation, not a target; a lone
    // forward slash has no continuation meaning and stays a protected root.
    .filter((target) => target !== '\\' && path.isAbsolute(target))
    .map((target) => normalizePath(path.resolve(target)))
    .some((target) => protectedRoots.some((root) => root === target || root.startsWith(`${target}${path.sep}`)));
}

function normalizePath(value) {
  return value.toLowerCase().replace(/[\\/]+$/, '');
}

// Deliberately NO subagent exemption here: the 2026-07-16 $home wipe was done
// by an executor. This guard binds every caller.
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
