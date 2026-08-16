'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const documents = require('../hooks/lib/map-documents');

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'remind.js');
const startHook = path.join(root, 'hooks', 'inject-context.js');
const hooksConfig = require('../hooks/hooks.json');

const TEST_LOCK_WAIT_MS = 5_000;

function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-'));
  const mapDirectory = path.join(directory, '.claude', '.codebase-info');
  fs.mkdirSync(mapDirectory, { recursive: true });
  fs.writeFileSync(path.join(mapDirectory, 'INDEX.md'), '# Example map\n\nRead focused docs as needed.\n');
  fs.writeFileSync(path.join(mapDirectory, 'architecture.md'), '# Architecture\n\nVersion one.\n');
  fs.writeFileSync(path.join(mapDirectory, 'modules.md'), '# Modules\n\nVersion one.\n');
  writeState(directory);
  return directory;
}

function writeState(projectDir) {
  const map = documents.loadMap(projectDir);
  fs.writeFileSync(path.join(projectDir, '.claude', '.codebase-info', '.map-state.json'), JSON.stringify({
    tool: 'codebase-mapper',
    version: '2.2.0',
    documents: map.documents.filter((entry) => entry.relative !== 'INDEX.md').map((entry) => entry.relative),
    hashes: documents.mapHashes(map.documents),
  }, null, 2) + '\n');
}

function hook(script, projectDir, stateDirectory, data) {
  // inject-context.js resolves the project from CLAUDE_PROJECT_DIR before data.cwd,
  // so an inherited value silently points every fixture at the real repo instead of
  // the temp map built above. Claude Code sets it, so leaving it through means the
  // suite only passes outside a live session.
  const { CLAUDE_PROJECT_DIR: _ignored, ...ambient } = process.env;
  return childProcess.execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: {
      ...ambient,
      CODEBASE_MAPPER_STATE_DIR: stateDirectory,
    },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

function hookAsync(script, projectDir, stateDirectory, data, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const { CLAUDE_PROJECT_DIR: _ignored, ...ambient } = process.env;
    const child = childProcess.spawn(process.execPath, [script], {
      cwd: projectDir,
      env: {
        ...ambient,
        CODEBASE_MAPPER_STATE_DIR: stateDirectory,
        CODEBASE_MAPPER_TEST_STATE_LOCK_WAIT_MS: String(TEST_LOCK_WAIT_MS),
        ...envOverrides,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd: projectDir, ...data }));
  });
}

async function waitForLockContenders(lockFile, count) {
  const directory = path.dirname(lockFile);
  const prefix = path.basename(lockFile) + '.';
  const deadline = Date.now() + TEST_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} contenders on ${lockFile}`);
}

async function waitForPath(file) {
  const deadline = Date.now() + TEST_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function publishStateLock(lockDirectory, ownerPid) {
  const generation = `fixture-${crypto.randomUUID()}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const ownerName = `owner-${generation}`;
  fs.mkdirSync(candidateDirectory, { recursive: true });
  fs.writeFileSync(path.join(candidateDirectory, ownerName), `${ownerPid}\n`);
  fs.renameSync(candidateDirectory, lockDirectory);
  return path.join(lockDirectory, ownerName);
}

function text(output) {
  return JSON.parse(output).hookSpecificOutput.additionalContext;
}

// SQ-1259, field-hit twice: the SubagentStart matcher injects this context into
// sidequest executors, and the main session's "run update-codebase-map, proceed
// immediately" line read as an instruction to them. Parallel executors on one tree
// would collide on the map, and a mid-wave map would describe unlanded state.
test('a subagent is forbidden to update the map; the main session keeps the instruction', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sub = text(hook(startHook, directory, state, {
    session_id: 'sub', source: 'startup', hook_event_name: 'SubagentStart', agent_type: 'sidequest-exec-dispatch',
  }));
  assert.match(sub, /NEVER update the codebase map/);
  assert.match(sub, /main session refreshes the map once/);
  assert.doesNotMatch(sub, /Running \/codebase-mapper:update-codebase-map/);
  assert.match(sub, /Codebase map: read/, 'subagents still read the map');

  const main = text(hook(startHook, directory, state, { session_id: 'main', source: 'startup' }));
  assert.match(main, /Running \/codebase-mapper:update-codebase-map/);
  assert.doesNotMatch(main, /NEVER update the codebase map/);
});

test('unchanged prompts are silent after session grounding', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  assert.match(text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' })), /INDEX\.md/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
});

test('one changed map document names only that document to reread', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /architecture\.md/);
  assert.doesNotMatch(output, /modules\.md/);
  assert.doesNotMatch(output, /Version two/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
});

test('a changed index is re-grounded without loading focused documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'INDEX.md'), '# Updated map\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /INDEX\.md/);
  assert.doesNotMatch(output, /architecture\.md/);
});

test('stale map hashes never hide a manual edit', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'modules.md'), '# Modules\n\nManual edit.\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /modules\.md/);
  assert.match(output, /hash manifest is stale/);
});

test('CRLF map documents retain their LF hashes', () => {
  const directory = project();
  const target = path.join(directory, '.claude', '.codebase-info', 'modules.md');
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n'));

  assert.strictEqual(documents.loadMap(directory).state.stale, false);
});

test('concurrent sessions keep independent map ledgers', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'first', source: 'startup' });
  hook(startHook, directory, state, { session_id: 'second', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  assert.match(text(hook(promptHook, directory, state, { session_id: 'first' })), /architecture\.md/);
  assert.match(text(hook(promptHook, directory, state, { session_id: 'second' })), /architecture\.md/);
});

test('SessionStart scopes re-grounding to its source and preserves seen documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const startup = text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' }));
  assert.match(startup, /SESSIONSTART \(startup\)/);
  assert.match(startup, /Read focused docs as needed/);
  assert.match(startup, /Before anything else in your first reply/);
  assert.match(startup, /Codebase map: read <doc\(s\)>/);
  assert.match(startup, /Codebase map: no read needed - <reason>/);
  assert.match(startup, /This is mandatory; do not silently skip it/);
  assert.match(startup, /only relevant map document\(s\)/);
  assert.match(startup, /Never re-read a document already read this session unless this hook names it as changed/);
  assert.match(startup, /Do not ask the user whether to update the map or run this skill/);
  assert.match(startup, /proceed immediately without waiting for a reply/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');

  assert.strictEqual(hook(startHook, directory, state, { session_id: 'one', source: 'resume' }), '');

  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  const compact = text(hook(startHook, directory, state, { session_id: 'one', source: 'compact' }));
  assert.match(compact, /SESSIONSTART \(compact\)/);
  assert.match(compact, /Read focused docs as needed/);
  assert.match(compact, /Before anything else in your first reply/);
  assert.match(compact, /Codebase map: read <doc\(s\)>/);
  assert.match(compact, /Codebase map: no read needed - <reason>/);
  const changedAfterCompact = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(changedAfterCompact, /architecture\.md/);

  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion three.\n');
  const resumedChange = text(hook(startHook, directory, state, { session_id: 'one', source: 'resume' }));
  assert.match(resumedChange, /SessionStart \(resume\)/);
  assert.match(resumedChange, /architecture\.md/);
  assert.doesNotMatch(resumedChange, /modules\.md/);
});

test('legacy maps gain a hash manifest on SessionStart without changing documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  const before = fs.readFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ documents: ['architecture.md', 'modules.md'] }) + '\n');
  const output = text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' }));
  assert.match(output, /INDEX\.md/);
  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(migrated.schemaVersion, 1);
  assert.deepStrictEqual(migrated.hashes, documents.mapHashes(documents.loadMap(directory).documents));
  assert.strictEqual(fs.readFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), 'utf8'), before);
  assert.ok(fs.existsSync(statePath + '.legacy.json'));
});

test('current maps no-op while future state and interrupted temps stay untouched', () => {
  const directory = project();
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  const current = fs.readFileSync(statePath, 'utf8');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  assert.strictEqual(fs.readFileSync(statePath, 'utf8'), current);
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 99, hashes: {} }) + '\n');
  fs.writeFileSync(statePath + '.tmp-interrupted', 'partial\n');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 99);
  assert.match(text(hook(startHook, directory, path.join(directory, 'state'), { session_id: 'future', source: 'startup' })), /newer schema/);
  assert.ok(fs.existsSync(statePath + '.tmp-interrupted'));
});

test('SubagentStart injects only for selected work agents and stays silent without a map', () => {
  const subagentHook = hooksConfig.hooks.SubagentStart[0];
  const matcher = new RegExp(subagentHook.matcher);
  assert.match(subagentHook.hooks[0].command, /hooks\/inject-context\.js/);
  assert.match('sidequest-exec-dispatch-high', matcher);
  assert.match('general-purpose', matcher);
  assert.match('codebase-mapper:map-writer', matcher);
  assert.doesNotMatch('Explore', matcher);

  const directory = project();
  const state = path.join(directory, 'state');
  const output = hook(startHook, directory, state, {
    session_id: 'subagent',
    hook_event_name: 'SubagentStart',
    agent_type: 'general-purpose',
  });
  const payload = JSON.parse(output).hookSpecificOutput;
  assert.strictEqual(payload.hookEventName, 'SubagentStart');
  assert.match(payload.additionalContext, /INDEX\.md/);
  assert.doesNotMatch(payload.additionalContext, /Version one/);

  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-empty-'));
  assert.strictEqual(hook(startHook, emptyDirectory, state, {
    hook_event_name: 'SubagentStart',
    agent_type: 'general-purpose',
  }), '');
});

test('stale map migration locks recover while fresh locks serialize concurrent starts', () => {
  const directory = project();
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ documents: ['architecture.md', 'modules.md'] }) + '\n');
  const lock = path.join(directory, '.claude', '.codebase-info.migration.lock');
  fs.writeFileSync(lock, 'active\n');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  const old = new Date(Date.now() - 61 * 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(documents.migrateLegacyMap(directory), true);
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
});

test('update announcements require the map update skill in the same main-session turn', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const turn = {
    hook_event_name: 'Stop',
    session_id: 'main',
    prompt_id: 'prompt',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };
  const blocked = JSON.parse(hook(startHook, directory, state, turn));
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /invoke Skill/i);
  assert.ok(Buffer.byteLength(blocked.reason) <= 192);
  assert.strictEqual(hook(startHook, directory, state, turn), '', 'unchanged responsibility emits only once even without the runtime re-entry flag');
  assert.strictEqual(hook(startHook, directory, state, {
    ...turn,
    last_assistant_message: 'I am still running /codebase-mapper:update-codebase-map before I finish.',
  }), '', 'rewording the same prompt does not create a new map-update responsibility');

  assert.strictEqual(hook(startHook, directory, state, { ...turn, stop_hook_active: true }), '');
  const nextPrompt = JSON.parse(hook(startHook, directory, state, { ...turn, prompt_id: 'next-prompt' }));
  assert.strictEqual(nextPrompt.decision, 'block', 'a new prompt is a new map-update responsibility');
  assert.strictEqual(hook(startHook, directory, state, {
    ...turn,
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'codebase-mapper:update-codebase-map' },
  }), '');
  assert.strictEqual(hook(startHook, directory, state, turn), '');
  assert.strictEqual(hook(startHook, directory, state, {
    ...turn,
    last_assistant_message: 'Documentation check complete. No documentation updates needed because the map still matches the code.',
  }), '');
  assert.strictEqual(hook(startHook, directory, state, { ...turn, agent_id: 'subagent' }), '');
});

test('update skill completion matches Stop despite host prompt id mismatch', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const stop = {
    hook_event_name: 'Stop',
    session_id: 'mismatched-host-prompts',
    prompt_id: 'stop-host-prompt',
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  assert.strictEqual(JSON.parse(hook(startHook, directory, state, stop)).decision, 'block');
  assert.strictEqual(hook(startHook, directory, state, {
    ...stop,
    hook_event_name: 'PreToolUse',
    prompt_id: 'tool-host-prompt',
    tool_name: 'Skill',
    tool_input: { skill: 'codebase-mapper:update-codebase-map' },
  }), '');
  assert.strictEqual(hook(startHook, directory, state, stop), '', 'the completed update matches by session');
  assert.strictEqual(JSON.parse(hook(startHook, directory, state, stop)).decision, 'block', 'the completion record is consumed');
});

test('overlapping prompt-less Stop processes atomically claim one veto', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sessionId = 'overlapping-documented-stop';
  const stateFile = path.join(state, 'stop-veto-' + require('node:crypto').createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const fixtureOwnerFile = publishStateLock(lockDirectory, process.pid);
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const pending = Promise.all([
    hookAsync(startHook, directory, state, stop),
    hookAsync(startHook, directory, state, stop),
  ]);
  await waitForLockContenders(lockDirectory, 2);
  fs.rmSync(lockDirectory, { recursive: true, force: true });
  const results = await pending;
  assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
  assert.strictEqual(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
  assert.strictEqual(hook(startHook, directory, state, stop), '');
});

test('overlapping Stop processes with distinct prompt ids atomically claim one batch veto', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sessionId = 'overlapping-distinct-prompts';
  const stateFile = path.join(state, 'stop-veto-' + require('node:crypto').createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const fixtureOwnerFile = publishStateLock(lockDirectory, process.pid);
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const pending = Promise.all([
    hookAsync(startHook, directory, state, { ...stop, prompt_id: 'first-host-prompt' }),
    hookAsync(startHook, directory, state, { ...stop, prompt_id: 'second-host-prompt' }),
  ]);
  await waitForLockContenders(lockDirectory, 2);
  fs.rmSync(lockDirectory, { recursive: true, force: true });
  const results = await pending;
  assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
  assert.strictEqual(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
});

test('an advancing transcript cannot split one prompt-independent Stop batch', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, '{"type":"assistant","message":"first"}\n');
  const sessionId = 'overlapping-advancing-transcript';
  const stateFile = path.join(state, 'stop-veto-' + crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  publishStateLock(lockDirectory, process.pid);
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    transcript_path: transcriptPath,
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const first = hookAsync(startHook, directory, state, { ...stop, prompt_id: 'first-host-prompt' });
  await waitForLockContenders(lockDirectory, 1);
  fs.appendFileSync(transcriptPath, '{"type":"system","message":"hook running"}\n');
  const second = hookAsync(startHook, directory, state, { ...stop, prompt_id: 'second-host-prompt' });
  await waitForLockContenders(lockDirectory, 2);
  fs.rmSync(lockDirectory, { recursive: true, force: true });

  const results = await Promise.all([first, second]);
  assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
  assert.strictEqual(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
});

test('transcript path presence and value cannot split one Stop batch', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sessionId = 'overlapping-transcript-path-metadata';
  const stateFile = path.join(state, 'stop-veto-' + crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const fixtureOwnerFile = publishStateLock(lockDirectory, process.pid);
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const pending = Promise.all([
    hookAsync(startHook, directory, state, stop),
    hookAsync(startHook, directory, state, { ...stop, transcript_path: path.join(directory, 'first.jsonl') }),
    hookAsync(startHook, directory, state, { ...stop, transcript_path: path.join(directory, 'second.jsonl') }),
  ]);
  await waitForLockContenders(lockDirectory, 3);
  fs.rmSync(fixtureOwnerFile, { force: true });
  fs.writeFileSync(path.join(lockDirectory, 'late-entry'), '');
  fs.rmSync(lockDirectory, { recursive: true, force: true });

  const results = await pending;
  assert.deepStrictEqual(results.map((result) => result.status), [0, 0, 0]);
  assert.strictEqual(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
});

test('two stale-lock cleaners cannot delete a live replacement generation', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sessionId = 'stale-cleaner-generation';
  const stateFile = path.join(state, 'stop-veto-' + crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  publishStateLock(lockDirectory, 99999999);

  const staleGate = path.join(directory, 'first-cleaner.gate');
  const staleMarker = path.join(directory, 'first-cleaner-inspected');
  const cleanedMarker = path.join(directory, 'first-cleaner-cleaned');
  const firstAcquiredMarker = path.join(directory, 'first-cleaner-acquired');
  const replacementHoldGate = path.join(directory, 'replacement.gate');
  const replacementAcquiredMarker = path.join(directory, 'replacement-acquired');
  fs.writeFileSync(staleGate, 'hold');
  fs.writeFileSync(replacementHoldGate, 'hold');
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const first = hookAsync(startHook, directory, state, stop, {
    CODEBASE_MAPPER_TEST_STALE_LOCK_GATE: staleGate,
    CODEBASE_MAPPER_TEST_STALE_LOCK_MARKER: staleMarker,
    CODEBASE_MAPPER_TEST_STALE_LOCK_CLEANED_MARKER: cleanedMarker,
    CODEBASE_MAPPER_TEST_LOCK_ACQUIRED_MARKER: firstAcquiredMarker,
  });
  await waitForPath(staleMarker);
  const replacement = hookAsync(startHook, directory, state, stop, {
    CODEBASE_MAPPER_TEST_LOCK_ACQUIRED_MARKER: replacementAcquiredMarker,
    CODEBASE_MAPPER_TEST_LOCK_HOLD_GATE: replacementHoldGate,
  });
  await waitForPath(replacementAcquiredMarker);
  const replacementOwnerName = fs.readdirSync(lockDirectory).find((name) => name.startsWith('owner-'));
  assert.ok(replacementOwnerName);
  const replacementOwner = path.join(lockDirectory, replacementOwnerName);

  let results;
  try {
    fs.rmSync(staleGate, { force: true });
    await waitForPath(cleanedMarker);
    assert.strictEqual(fs.existsSync(replacementOwner), true, 'the first cleaner preserves the replacement generation');
    assert.strictEqual(fs.existsSync(firstAcquiredMarker), false, 'the first cleaner cannot acquire through the live replacement');
  } finally {
    fs.rmSync(staleGate, { force: true });
    fs.rmSync(replacementHoldGate, { force: true });
    results = await Promise.all([first, replacement]);
  }
  assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
  assert.strictEqual(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
});

test('a releasing Stop lock cannot remove a replacement generation', async () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const sessionId = 'replacement-during-release';
  const stateFile = path.join(state, 'stop-veto-' + crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  const lockDirectory = stateFile + '.lock-v2';
  const retiredLockDirectory = lockDirectory + '.retired';
  const releaseGate = path.join(directory, 'release.gate');
  const releaseMarker = path.join(directory, 'release.marker');
  const preload = path.join(directory, 'pause-release.js');
  fs.writeFileSync(releaseGate, 'hold');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const lockDirectory = process.env.CODEBASE_MAPPER_TEST_RELEASE_LOCK_DIRECTORY;',
    'const releaseGate = process.env.CODEBASE_MAPPER_TEST_RELEASE_GATE;',
    'const releaseMarker = process.env.CODEBASE_MAPPER_TEST_RELEASE_MARKER;',
    'const originalRemove = fs.rmSync;',
    'let paused = false;',
    'fs.rmSync = function removeWithReleasePause(file, options) {',
    '  const result = originalRemove.call(this, file, options);',
    "  if (!paused && path.dirname(file) === lockDirectory && path.basename(file).startsWith('owner-')) {",
    '    paused = true;',
    "    fs.writeFileSync(releaseMarker, process.pid + '\\n');",
    '    while (fs.existsSync(releaseGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '  }',
    '  return result;',
    '};',
  ].join('\n'));
  const stop = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  const pending = hookAsync(startHook, directory, state, stop, {
    CODEBASE_MAPPER_TEST_RELEASE_LOCK_DIRECTORY: lockDirectory,
    CODEBASE_MAPPER_TEST_RELEASE_GATE: releaseGate,
    CODEBASE_MAPPER_TEST_RELEASE_MARKER: releaseMarker,
    NODE_OPTIONS: `--require=${preload}`,
  });
  await waitForPath(releaseMarker);
  fs.renameSync(lockDirectory, retiredLockDirectory);
  const replacementOwner = publishStateLock(lockDirectory, process.pid);
  fs.rmSync(releaseGate, { force: true });
  const result = await pending;

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  assert.strictEqual(fs.existsSync(replacementOwner), true, 'release cleanup preserves a replacement lock generation');
  fs.rmSync(lockDirectory, { recursive: true, force: true });
  fs.rmSync(retiredLockDirectory, { recursive: true, force: true });
});

test('prompt-less Stop responsibilities reset after the map update and warn again later', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const stop = {
    hook_event_name: 'Stop',
    session_id: 'documented-stop-fields',
    reason: 'end_turn',
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };

  assert.strictEqual(JSON.parse(hook(startHook, directory, state, stop)).decision, 'block');
  assert.strictEqual(hook(startHook, directory, state, stop), '', 'one unchanged prompt-less Stop event emits once');

  assert.strictEqual(hook(startHook, directory, state, {
    ...stop,
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'codebase-mapper:update-codebase-map' },
  }), '');
  assert.strictEqual(hook(startHook, directory, state, stop), '', 'the completed update consumes its prompt-less invocation record');

  assert.strictEqual(JSON.parse(hook(startHook, directory, state, stop)).decision, 'block', 'a later independent warning in the same session is actionable');
  assert.strictEqual(hook(startHook, directory, state, stop), '');
  assert.strictEqual(hook(startHook, directory, state, {
    ...stop,
    last_assistant_message: 'Documentation check complete. No documentation updates needed because the map matches the code.',
  }), '');
  assert.strictEqual(JSON.parse(hook(startHook, directory, state, stop)).decision, 'block', 'ending the responsibility resets the event boundary');
});

test('the stop hook tracks update skill use and preserves the main-session instruction', () => {
  assert.match(hooksConfig.description, /atomically emits one independent <=192 B Stop veto/);
  assert.match(hooksConfig.description, /generation-bound stale-lock cleanup cannot delete a live replacement/);
  assert.match(hooksConfig.description, /overlapping hook processes/);
  assert.match(hooksConfig.description, /Claude batches concurrent blocking hooks into one continuation/);
  assert.match(hooksConfig.description, /stable message and reason identity ignores optional prompt and transcript host metadata/);
  assert.match(hooksConfig.description, /update-skill completion matches by session when host prompt ids differ/);
  assert.match(hooksConfig.description, /stop_hook_active re-entry stays silent/);
  const main = hooksConfig.hooks.Stop[0];
  const skill = hooksConfig.hooks.PreToolUse[0];
  assert.match(main.hooks[0].command, /hooks\/inject-context\.js/);
  assert.strictEqual(skill.matcher, 'Skill');
  assert.match(skill.hooks[0].command, /hooks\/inject-context\.js/);

  const directory = project();
  const state = path.join(directory, 'state');
  const instruction = text(hook(startHook, directory, state, { session_id: 'main', source: 'startup' }));
  assert.match(instruction, /That announcement is not the action/);
  assert.match(instruction, /invoke Skill `codebase-mapper:update-codebase-map` before ending the turn/);
});
