'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHILD_PROCESS_REQUIRE = /require\(\s*['"](?:node:)?child_process['"]\s*\)/;
const CHILD_PROCESS_CALL = '(spawnSync|spawn|execFileSync|execFile|execSync|exec)(?:\\s*\\(|\\s*\\)\\s*\\()';
const CHILD_PROCESS_NAMESPACE = /\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g;
const SKIPPED_DIRECTORIES = new Set(['.claude', '.claude-plugin', 'node_modules', 'test']);

function callEnd(source, openingParenthesis) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingParenthesis; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function lineNumber(source, position) {
  return source.slice(0, position).split('\n').length;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function childProcessCallPattern(source) {
  const namespaces = [...source.matchAll(CHILD_PROCESS_NAMESPACE)].map((match) => escapeRegex(match[1]));
  const prefix = namespaces.length ? `(?:(?:${namespaces.join('|')})\\s*\\.\\s*)?` : '';
  return new RegExp(`(?<![\\w$.])${prefix}${CHILD_PROCESS_CALL}`, 'g');
}

function inspectSource(source, file) {
  if (!CHILD_PROCESS_REQUIRE.test(source)) return [];
  const calls = [];
  for (const match of source.matchAll(childProcessCallPattern(source))) {
    const start = match.index;
    const openingParenthesis = source.indexOf('(', start + match[0].length - 1);
    const end = callEnd(source, openingParenthesis);
    const text = source.slice(start, end);
    const context = source.slice(Math.max(0, start - 160), start);
    calls.push({
      file,
      line: lineNumber(source, start),
      call: match[1],
      hidden: /windowsHide\s*:\s*true/.test(text) || /\/\/\s*windows-visible:/.test(context),
    });
  }
  return calls;
}

function productionFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...productionFiles(path.join(root, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

function inspectPlugin(root) {
  return productionFiles(root).flatMap((file) => inspectSource(fs.readFileSync(file, 'utf8'), file));
}

function unhiddenCalls(calls) {
  return calls.filter((call) => !call.hidden);
}

module.exports = { inspectPlugin, inspectSource, unhiddenCalls };
