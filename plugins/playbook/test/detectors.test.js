'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { mine } = require('../lib/mine.js');
const { MAX_TOOL_DURATION_MS, streamTranscript } = require('../lib/stream.js');
const { createTranscript, makeRoot } = require('./helpers/transcripts.js');

const noGit = () => new Set();

function run(root, overrides = {}) {
  return mine({ root, slug: 'proj', days: 7, sessions: 5, projectPath: 'C:/project', git: noGit, now: Date.now(), ...overrides });
}

function find(result, kind) {
  return result.findings.filter((finding) => finding.kind === kind);
}

test('tool result events retain recorded durations', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' })
    .tool('Bash', { command: 'npm test' }, { result: 'ok', durationMs: 1234 })
    .write();
  const events = [];
  await streamTranscript({ file: path.join(root, 'proj', 's1.jsonl'), scope: 'main', sessionId: 's1' }, [{ onEvent: (event) => events.push(event) }]);
  assert.equal(events.find((event) => event.kind === 'tool_result').durationMs, 1234);
});

test('command durations fall back to timestamps and cap background outliers', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' });
  for (let index = 0; index < 3; index += 1) main.tool('Bash', { command: 'npm run verify' }, { result: 'ok', resultGapMs: 800 });
  for (let index = 0; index < 3; index += 1) main.tool('Bash', { command: 'npm run slow-verify' }, { result: 'ok', durationMs: MAX_TOOL_DURATION_MS * 10 });
  main.write();

  const result = await run(root);
  const [fallback] = find(result, 'repeated-command').filter((finding) => finding.title.includes('npm run verify'));
  const [outlier] = find(result, 'repeated-command').filter((finding) => finding.title.includes('npm run slow-verify'));
  assert.equal(fallback.totalDurationMs, 2400);
  assert.equal(fallback.averageDurationMs, 800);
  assert.equal(outlier.totalDurationMs, MAX_TOOL_DURATION_MS * 3);
  assert.equal(result.totals.measuredToolDurationMs, 2400 + MAX_TOOL_DURATION_MS * 3);
});

test('a command repeated three times across worktrees is one finding with its arguments named', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (const worktree of ['agent-a', 'agent-b', 'agent-c']) {
    main.tool('Bash', { command: `npm run test:full --prefix "C:/repo/.claude/worktrees/${worktree}/plugins/sidequest"` }, { result: 'pass' });
  }
  main.write();

  const result = await run(root);
  const repeated = find(result, 'repeated-command');
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].occurrences, 3);
  const [argument] = repeated[0].arguments;
  assert.equal(argument.token, '<path>');
  assert.equal(argument.distinct, 3);
});

test('the same chore written two ways is merged rather than reported twice', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (let index = 0; index < 3; index += 1) {
    main.tool('Bash', { command: `npm ci --prefix "C:/repo/wt-${index}/plugins/sidequest"` }, { result: 'ok' });
    main.tool('Bash', { command: `npm --prefix "C:/repo/wt-${index}/plugins/sidequest" ci` }, { result: 'ok' });
  }
  main.write();

  const result = await run(root);
  const repeated = find(result, 'repeated-command');
  assert.equal(repeated.length, 1, 'both spellings of npm ci must land in one finding');
  assert.equal(repeated[0].occurrences, 6);
  assert.ok(repeated[0].variants.length >= 2);
});

test('navigating around is not reported as repeated work', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (let index = 0; index < 6; index += 1) main.tool('Bash', { command: 'git status' }, { result: '' });
  main.write();

  const result = await run(root);
  assert.equal(find(result, 'repeated-command').length, 0);
  assert.equal(result.notes.commands.trivialInvocations, 6);
});

test('a failure and the retry that fixed it are paired, and the fix is named', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (let index = 0; index < 3; index += 1) {
    main.tool('Bash', { command: 'npm ci' }, { result: 'npm ERR! no lockfile found', isError: true });
    main.tool('Bash', { command: `npm ci --prefix "C:/repo/wt-${index}/plugins/sidequest"` }, { result: 'added 40 packages' });
  }
  main.write();

  const result = await run(root);
  const fixes = find(result, 'fail-then-fix');
  assert.equal(fixes.length, 1, 'the same correction in three worktrees is one finding');
  assert.deepEqual(fixes[0].delta.added, ['--prefix', '"<path>"']);
});

test('two unrelated commands sharing a name are not fabricated into a fix', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (let index = 0; index < 3; index += 1) {
    main.tool('Bash', { command: 'npm run build' }, { result: 'boom', isError: true });
    main.tool('Bash', { command: 'npm run test:full --prefix "C:/repo/a" --reporter spec --bail --coverage' }, { result: 'ok' });
  }
  main.write();

  const result = await run(root);
  assert.equal(find(result, 'fail-then-fix').length, 0);
});

test('a script rewritten across sessions is salvaged with the body that last worked', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' })
    .prompt('go')
    .tool('Write', { file_path: 'C:/tmp/probe.mjs', content: 'console.log("first attempt");' })
    .write();
  createTranscript({ root, slug: 'proj', sessionId: 's2' })
    .prompt('go')
    .tool('Write', { file_path: 'C:/tmp/probe.mjs', content: 'console.log("working version");' })
    .tool('Bash', { command: 'node C:/tmp/probe.mjs' }, { result: 'working version' })
    .write();

  const result = await run(root);
  const [rewritten] = find(result, 'rewritten-script');
  assert.ok(rewritten, 'a twice-written script is the highest-value find and must be reported');
  assert.equal(rewritten.proven, true);
  const salvaged = result.salvageBodies.find((item) => item.id === rewritten.salvageId);
  assert.equal(salvaged.content, 'console.log("working version");');
  assert.equal(salvaged.proof.stdout, 'working version');
});

test('reads before the first change are costed in active time, not wall clock', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  main.tool('Read', { file_path: 'C:/project/a.ts' }, { result: 'x' });
  main.tool('Read', { file_path: 'C:/project/b.ts' }, { result: 'x' });
  // An hour of the session was spent waiting on a human, which is not time a map entry could win back.
  main.tool('Read', { file_path: 'C:/project/c.ts' }, { result: 'x', gapMs: 3600000 });
  main.tool('Write', { file_path: 'C:/project/a.ts', content: 'done' }, { result: 'ok' });
  main.write();

  const result = await run(root);
  const [tax] = find(result, 'rediscovery-tax');
  assert.ok(tax);
  assert.match(tax.title, /3 orienting reads/);
  assert.ok(!/~6[0-9] min/.test(tax.title), `idle time leaked into the cost: ${tax.title}`);
});

test('a repeated correction is themed and kept verbatim', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' })
    .prompt('go')
    .tool('Bash', { command: 'git commit -m wip' }, { result: 'ok' })
    .prompt('no, do not commit unless I ask you to')
    .write();
  createTranscript({ root, slug: 'proj', sessionId: 's2' })
    .prompt('go')
    .tool('Bash', { command: 'git push' }, { result: 'ok' })
    .prompt("stop pushing to main, I told you that already")
    .write();

  const result = await run(root);
  const [correction] = find(result, 'user-correction');
  assert.equal(correction.theme, 'commit/git');
  assert.equal(correction.occurrences, 2);
  assert.ok(correction.evidence.some((item) => item.text.includes('do not commit unless I ask')));
});

test('private data in an untracked, unignored path outranks everything and names no secret', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  main.tool('Write', { file_path: 'C:/project/.env.local', content: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345' }, { result: 'ok' });
  for (let index = 0; index < 5; index += 1) main.tool('Bash', { command: 'npm run build --silent --workspaces' }, { result: 'ok' });
  main.write();

  const result = await run(root, { git: () => new Set(['.env.local']) });
  assert.equal(result.findings[0].kind, 'hazard-private-data', 'a hazard must sort above frequency findings');
  assert.equal(result.findings[0].severity, 'critical');
  assert.ok(JSON.stringify(result.findings).includes('.env.local'));
  assert.ok(!JSON.stringify(result).includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'the secret itself must never be reported');
});

test('new untracked source is not called a hazard when nothing tried to stage it', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
    main.tool('Write', { file_path: `C:/project/src/${name}`, content: 'export const x = 1;' }, { result: 'ok' });
  }
  main.write();

  const untracked = new Set(['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
  const result = await run(root, { git: () => untracked });
  assert.equal(find(result, 'hazard-untracked').length, 0);
  assert.match(result.notes.hazards.untrackedNote, /expected for new work/);
});

test('the same untracked files during a bulk stage do become a hazard', async () => {
  const root = makeRoot();
  const main = createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go');
  for (const name of ['a.js', 'b.js', 'c.js']) {
    main.tool('Write', { file_path: `C:/project/src/${name}`, content: 'export const x = 1;' }, { result: 'ok' });
  }
  main.tool('Bash', { command: 'git add -A' }, { result: '' });
  main.write();

  const untracked = new Set(['src/a.js', 'src/b.js', 'src/c.js']);
  const result = await run(root, { git: () => untracked });
  assert.equal(find(result, 'hazard-untracked').length, 1);
});

test('work is attributed to the executors that did it, not to the session', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' }).prompt('go').write();
  for (const agent of ['agent-1', 'agent-2', 'agent-3']) {
    createTranscript({ root, slug: 'proj', sessionId: 's1', agent: { id: agent, type: 'sidequest-exec-dispatch-high' } })
      .tool('Bash', { command: `git -C "C:/repo/${agent}" rev-parse --git-dir && git -C "C:/repo/${agent}" status --short` }, { result: 'ok' })
      .write();
  }

  const result = await run(root);
  const [repeated] = find(result, 'repeated-command');
  assert.equal(repeated.audience.primary, 'subagents');
  assert.equal(repeated.actors[0].label, 'subagent:sidequest-exec-dispatch-high');
  assert.equal(repeated.actors[0].count, 3);
});

test('a quiet window produces no findings instead of manufactured ones', async () => {
  const root = makeRoot();
  createTranscript({ root, slug: 'proj', sessionId: 's1' })
    .prompt('add a comment')
    .tool('Read', { file_path: 'C:/project/a.ts' }, { result: 'x' })
    .tool('Edit', { file_path: 'C:/project/a.ts' }, { result: 'ok' })
    .write();

  const result = await run(root);
  assert.equal(result.findings.length, 0);
});
