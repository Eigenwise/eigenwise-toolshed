'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { parseArgs } = require('../bin/skill-retro.js');
const { formatReport } = require('../lib/report.js');
const { mine, writeResults } = require('../lib/mine.js');
const { enabled, every, stateFile } = require('../hooks/session-nudge.js');
const { createTranscript, makeRoot } = require('./helpers/transcripts.js');

test('the CLI defaults to this project, seven days, and five sessions', () => {
  const options = parseArgs([]);
  assert.equal(options.command, 'mine');
  assert.equal(options.days, 7);
  assert.equal(options.sessions, 5);
  assert.equal(options.allProjects, false);
  assert.equal(options.includeSubagents, true);
});

test('scope and window are all overridable from the command line', () => {
  const options = parseArgs(['mine', '--days', '2', '--sessions', '20', '--all-projects', '--no-subagents', '--project', '.']);
  assert.equal(options.days, 2);
  assert.equal(options.sessions, 20);
  assert.equal(options.allProjects, true);
  assert.equal(options.includeSubagents, false);
  assert.equal(options.projectPath, path.resolve('.'));
});

test('a bad argument fails loudly instead of being ignored', () => {
  assert.throws(() => parseArgs(['mine', '--dayz', '3']), /Unknown argument/);
  assert.throws(() => parseArgs(['mine', '--days']), /needs a value/);
  assert.throws(() => parseArgs(['mine', '--days', '0']), /positive number/);
  assert.throws(() => parseArgs(['mine', '--format', 'yaml']), /text or json/);
});

test('a run writes a report, a findings file, and the salvaged bodies beside them', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' })
    .prompt('go')
    .tool('Write', { file_path: 'C:/tmp/probe.mjs', content: 'console.log(1);' })
    .write();
  createTranscript({ root, slug: 'proj', sessionId: 's2' })
    .prompt('go')
    .tool('Write', { file_path: 'C:/tmp/probe.mjs', content: 'console.log(2);' })
    .write();

  const result = await mine({ root, slug: 'proj', days: 7, sessions: 5, projectPath: 'C:/project', git: () => new Set() });
  const outputDir = path.join(os.tmpdir(), `skill-retro-cli-${Date.now()}`);
  const { findingsFile } = writeResults(result, outputDir);
  fs.writeFileSync(path.join(outputDir, 'report.md'), formatReport(result), 'utf8');

  const saved = JSON.parse(fs.readFileSync(findingsFile, 'utf8'));
  assert.equal(saved.salvageBodies, undefined, 'script bodies belong on disk, not in the file the model reads');
  assert.equal(saved.salvage.length, 1);
  assert.ok(fs.existsSync(path.join(outputDir, 'salvage', 'salvage-1-probe.mjs')));
  assert.equal(fs.readFileSync(path.join(outputDir, 'salvage', 'salvage-1-probe.mjs'), 'utf8'), 'console.log(2);');
});

test('the report always states the window, including what the cap skipped', async () => {
  const root = makeRoot();
  const now = Date.now();
  for (let index = 0; index < 8; index += 1) {
    createTranscript({ root, slug: 'proj', sessionId: `s${index}` }).prompt('go').write();
    const file = path.join(root, 'proj', `s${index}.jsonl`);
    const age = now - index * 3600000;
    fs.utimesSync(file, new Date(age), new Date(age));
  }

  const result = await mine({ root, slug: 'proj', days: 7, sessions: 5, projectPath: 'C:/project', git: () => new Set(), now });
  const report = formatReport(result);
  assert.match(report, /Window: /);
  assert.match(report, /capped at 5 sessions \(3 older ones/);
  assert.match(report, /5 sessions \+ 0 subagent transcripts/);
});

test('a quiet window is reported as a real result, not as an empty one', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go').write();
  const result = await mine({ root, slug: 'proj', days: 7, sessions: 5, projectPath: 'C:/project', git: () => new Set() });
  assert.match(formatReport(result), /That is a real result, not an empty one/);
});

test('the nudge hook stays inert unless it was opted into', () => {
  assert.equal(enabled({}), false);
  assert.equal(enabled({ SKILL_RETRO_NUDGE: 'off' }), false);
  assert.equal(enabled({ SKILL_RETRO_NUDGE: 'on' }), true);
  assert.equal(enabled({ SKILL_RETRO_NUDGE: '1' }), true);
});

test('the nudge threshold is configurable and falls back to a sane default', () => {
  assert.equal(every({}), 10);
  assert.equal(every({ SKILL_RETRO_NUDGE_EVERY: '3' }), 3);
  assert.equal(every({ SKILL_RETRO_NUDGE_EVERY: 'lots' }), 10);
});

test('nudge state is kept per project, outside the project directory', () => {
  const file = stateFile('C:/dev/app', { CLAUDE_CONFIG_DIR: 'C:/cfg' });
  assert.equal(path.dirname(file), path.join('C:/cfg', 'skill-retro-state'));
  assert.match(path.basename(file), /^C--dev-app\.json$/);
});
