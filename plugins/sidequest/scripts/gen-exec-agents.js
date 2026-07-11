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
//
// Renders through the same lib/agentsync.js#renderExecAgent() that the
// runtime per-custom-model agent sync (SQ-158) uses, so both generation paths
// share one template and can never drift apart. The five built-in calls below
// omit modelId/marker/extraNote, which renderExecAgent substitutes as empty —
// producing byte-identical output to the pre-refactor inline substitution.
'use strict';

const fs = require('fs');
const path = require('path');
const { renderExecAgent } = require('../lib/agentsync.js');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function main() {
  for (const effort of EFFORTS) {
    const content = renderExecAgent({ name: `sidequest-exec-${effort}`, effort });
    const outPath = path.join(AGENTS_DIR, `sidequest-exec-${effort}.md`);
    fs.writeFileSync(outPath, content);
    console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  }
}

main();
