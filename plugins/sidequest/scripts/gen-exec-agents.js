#!/usr/bin/env node
// Regenerates the five sidequest-exec-<effort>.md agent files from the single
// source template plugins/sidequest/scripts/_exec-template.md.
//
// Usage: node plugins/sidequest/scripts/gen-exec-agents.js
//
// Why this exists: the Agent tool resolves subagent_type by exact agent file
// name, and per-spawn reasoning effort can only be pinned via each agent
// definition's `effort:` frontmatter (there is no per-spawn effort argument,
// unlike `model`). So five near-identical .md files must exist on disk. This
// script keeps them byte-identical except for the effort token, instead of
// hand-editing five copies and risking drift.
'use strict';

const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const TEMPLATE_PATH = path.join(__dirname, '_exec-template.md');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PLACEHOLDER = '{{EFFORT}}';

function main() {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  for (const effort of EFFORTS) {
    const content = template.split(PLACEHOLDER).join(effort);
    const outPath = path.join(AGENTS_DIR, `sidequest-exec-${effort}.md`);
    fs.writeFileSync(outPath, content);
    console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  }
}

main();
