'use strict';

const fs = require('node:fs');
const path = require('node:path');

const policyPath = path.join(__dirname, '..', '..', 'skills', 'whittle', 'SKILL.md');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function section(text, name) {
  const normalized = text.replace(/\r\n/g, '\n');
  const header = '## ' + name + '\n';
  const start = normalized.indexOf(header);
  if (start < 0) return '';
  const contentStart = start + header.length;
  const end = normalized.indexOf('\n## ', contentStart);
  return normalized.slice(contentStart, end < 0 ? undefined : end).trim();
}

function instructions() {
  try {
    return section(fs.readFileSync(policyPath, 'utf8'), 'Clean-code policy');
  } catch (_) {
    return '';
  }
}

function handleHook(eventName) {
  return eventName === 'SessionStart' || eventName === 'SubagentStart' ? instructions() : '';
}

module.exports = { handleHook, instructions, readInput };
