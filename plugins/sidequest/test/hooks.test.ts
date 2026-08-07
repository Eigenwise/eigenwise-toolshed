import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// A throwaway store home so the SubagentStop hook (which loads lib/store.js as a
// subprocess and inherits this env) reads a fixture board, never the real one. The
// other hooks in this file don't touch the store, so this redirect is harmless to
// them. Set BEFORE requiring store so its lazy home resolution picks it up.
const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-test-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-luna', id: 'claude-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna' },
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const { EFFORTS, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require('../lib/exec-names.js');
const BOARD_PATH = path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board');
const { slug } = store.ensureProject(BOARD_PATH);
const database = db.openDb(SIDEQUEST_HOME);

const HOOKS = path.join(__dirname, '..', 'hooks');
const SESSION = path.join(HOOKS, 'session-start.js');
const SESSION_END = path.join(HOOKS, 'session-end.js');
const FORCE_BYPASS = path.join(HOOKS, 'force-exec-bypass.js');
const SUBAGENT_START = path.join(HOOKS, 'subagent-start.js');
const SUBAGENT_STOP = path.join(HOOKS, 'subagent-stop.js');
const TEAMMATE_IDLE = path.join(HOOKS, 'teammate-idle.js');
const GUARD_PEER = path.join(HOOKS, 'guard-peer-message.js');
const GUARD_HOME_DELETE = path.join(HOOKS, 'guard-home-delete.js');
const GUARD_WORKTREE_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');
const GUARD_BASH_WINDOWS_PATHS = path.join(HOOKS, 'guard-bash-windows-paths.js');
const GUARD_POWERSHELL_CMD_SHIMS = path.join(HOOKS, 'guard-powershell-cmd-shims.js');
const NEAR_TURN_CAP = path.join(HOOKS, 'near-turn-cap.js');
const REPEATED_COMMAND_WARN = path.join(HOOKS, 'repeated-command-warn.js');
const INLINE_WORK_NUDGE = path.join(HOOKS, 'inline-work-nudge.js');
const BOARD_FIRST_REMINDER = path.join(HOOKS, 'board-first-reminder.js');
const BOARD_RECONCILIATION_REMINDER = path.join(HOOKS, 'board-reconciliation-reminder.js');
const GUARD_TASK_OUTPUT = path.join(HOOKS, 'guard-task-output.js');
const GUARD_SHARED_TREE_COMMIT = path.join(HOOKS, 'guard-shared-tree-commit.js');

// Budget tests pin the plugin root because the nudge embeds it in CLI fallbacks.
const BUDGET = {
  session: 5200,
  compact: 3200,
  workforce: 1800,
  reconciliation: 360,
  longrun: 400, // SubagentStop runaway note — one short line, like the standing reminder
};
const PLUGIN_ROOT = fs.realpathSync(path.join(__dirname, '..'));
const PINNED_ROOT_NAME_LENGTH = 'sq-plugin-root'.length;
const PINNED_ROOT_NAME = crypto
  .createHash('sha256')
  .update(PLUGIN_ROOT)
  .digest('hex')
  .slice(0, PINNED_ROOT_NAME_LENGTH);
const FIXED_PLUGIN_ROOT = path.join(os.tmpdir(), PINNED_ROOT_NAME);

function ensurePinnedPluginRoot() {
  let currentTarget;
  let pinnedRootExists = false;
  try {
    fs.lstatSync(FIXED_PLUGIN_ROOT);
    pinnedRootExists = true;
    currentTarget = fs.realpathSync(FIXED_PLUGIN_ROOT);
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') throw error;
  }
  if (pinnedRootExists && currentTarget !== PLUGIN_ROOT) {
    fs.rmSync(FIXED_PLUGIN_ROOT, { recursive: true, force: true });
  }
  if (currentTarget !== PLUGIN_ROOT) {
    try {
      fs.symlinkSync(PLUGIN_ROOT, FIXED_PLUGIN_ROOT, 'junction');
    } catch (error) {
      if ((error as any)?.code !== 'EEXIST') throw error;
    }
  }
  assert.equal(fs.realpathSync(FIXED_PLUGIN_ROOT), PLUGIN_ROOT);
}

ensurePinnedPluginRoot();

const RETIRED_SCOUT = `sidequest-${'scout'}`;

// Run a hook with the given stdin payload and return the injected
// additionalContext string (or '' when the hook stays silent).
function runHookOutput(script?: any, payload?: any, envOverrides?: any) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(envOverrides || {}) },
  });
  return out.trim() ? JSON.parse(out) : null;
}

function runHook(script?: any, payload?: any, envOverrides?: any) {
  const parsed = runHookOutput(script, payload, envOverrides);
  if (!parsed) return '';
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

function windowsShortPath(pathname: string): string {
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
}

function runSessionWithHome(home?: any, envOverrides?: any) {
  return execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'bootstrap-test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME: home, ...(envOverrides || {}) },
  });
}

function runHookOutputForBudget(script?: any, payload?: any, envOverrides?: any) {
  return runHookOutput(script, payload, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

function runHookForBudget(script?: any, payload?: any, envOverrides?: any) {
  return runHook(script, payload, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

function runSessionWithHomeForBudget(home?: any, envOverrides?: any) {
  return runSessionWithHome(home, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

function unpinnedBudgetTests(source?: any) {
  return source
    .split(/\n(?=test\()/)
    .filter((block?: any) => block.includes('BUDGET.') && !block.includes('budget assertions must use a fixed plugin root') && !block.includes('runHookForBudget') && !block.includes('runHookOutputForBudget') && !block.includes('runSessionWithHomeForBudget'));
}

test('budget assertions must use a fixed plugin root', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  assert.deepStrictEqual(unpinnedBudgetTests(source), [], 'budget assertions must use a budget helper that pins CLAUDE_PLUGIN_ROOT');

  const fixture = "test('fixture', () => { const ctx = runHook(SESSION); assert.ok(ctx.length <= BUDGET.session); });";
  assert.equal(unpinnedBudgetTests(fixture).length, 1, 'the guard must reject an unpinned budget assertion');
});

test('budget pin resolves to this checkout and isolates its fixed-length path', () => {
  assert.equal(path.basename(FIXED_PLUGIN_ROOT).length, PINNED_ROOT_NAME_LENGTH);
  assert.equal(fs.realpathSync(FIXED_PLUGIN_ROOT), PLUGIN_ROOT);

  const otherPluginRoot = `${PLUGIN_ROOT}-other`;
  const otherName = crypto.createHash('sha256').update(otherPluginRoot).digest('hex').slice(0, PINNED_ROOT_NAME_LENGTH);
  assert.notEqual(otherName, PINNED_ROOT_NAME);
});

function writeCategory(home?: any, category?: any) {
  const database = db.openDb(home);
  const profileId = database.prepare('SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get().new_project_profile_id;
  const position = Number(database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM routing_profile_entries WHERE profile_id = ?').get(profileId).position);
  db.putRow(database, 'routing_profile_entries', {
    profile_id: profileId,
    category_id: category.id,
    data: category,
    position,
    updated_at: new Date().toISOString(),
  });
  database.close();
}

function writeModelPrefs(home?: any, prefs?: any) {
  const database = db.openDb(home);
  db.putRow(database, 'globals', { key: 'model-prefs', data: prefs });
}

// Phrases from the retired heavy doctrine that must NOT come back to any block.
const RETIRED = ['95%', 'read ~4+ files', 'AskUserQuestion', 'coreDiscipline'];

function assertNoRetiredDoctrine(ctx?: any, where?: any) {
  for (const phrase of RETIRED) {
    assert.ok(!ctx.includes(phrase), `${where} must not carry retired doctrine ("${phrase}")`);
  }
}

function gitFixture(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

test('pre-tool hook: exact Sidequest executors remain allowed and forced to bypass', () => {
  const original = {
    subagent_type: 'sidequest-exec-high',
    isolation: 'worktree',
    model: 'grade-3',
    name: 'sq36-srs-cards',
    prompt: 'work SQ-36',
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: original });
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, {
    ...original,
    mode: 'bypassPermissions',
  });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('pre-tool hook: a spawn prompt naming another ticket still records its launch', () => {
  // Spawn prompts carry ticket title, description, and anchors, so a ticket that
  // mentions another ticket puts two SQ refs in the prompt. Pairing refs to tokens
  // by counting them prompt-wide recorded no launch at all, and the executor then
  // failed its claim with unbound_dispatch (2026-08-07, sidequest 4.40.0).
  const ticket = store.createTicket(slug, {
    title: 'Four parameterised node kinds, following the pattern SQ-49 pinned',
    description: 'Mirror what SQ-51 established, and keep SQ-52 unaffected.',
    category: 'debugging',
    source: 'cli',
  });
  const sessionId = `prompt-extra-refs-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const command = `node "C:\\\\launcher\\\\sidequest-launcher.js" briefing ${ticket.ref} --token ${prepared.token} --project "${BOARD_PATH}"`;
  const prompt = [
    '[sidequest-route model=gpt-5.6-terra effort=high]',
    '',
    'Implementation context:',
    `Title: ${ticket.title}`,
    'Description:',
    'Mirror what SQ-51 established, and keep SQ-52 unaffected.',
    '',
    `FIRST action: run \`${command}\` and execute exactly what it prints.`,
  ].join('\n');

  runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    session_id: sessionId,
    cwd: BOARD_PATH,
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      isolation: 'worktree',
      name: 'sq-extra-refs',
      prompt,
    },
  });

  const launched = store.getTicket(slug, ticket.ref);
  assert.ok(launched.dispatch?.launchedAt, 'the launch must be recorded even when the prompt names other tickets');
});

test('pre-tool hook: shared-tree claims cannot run raw git commit', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-shared-commit-'));
  gitFixture(['init', '--quiet'], projectPath);
  gitFixture(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], projectPath);
  const project = store.ensureProject(projectPath).slug;
  const ticket = store.createTicket(project, { title: 'shared commit guard', category: 'debugging', source: 'cli' });
  const sessionId = `shared-commit-${++sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId, sharedTree: true });
  const agentId = `shared-commit-agent-${sqSeq}`;
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'shared-commit-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  const payload = {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: agentId,
    cwd: projectPath,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "bypass"' },
  };
  const blocked = runHookOutput(GUARD_SHARED_TREE_COMMIT, payload);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /mcp__plugin_sidequest_board__commit/);

  assert.equal(runHookOutput(GUARD_SHARED_TREE_COMMIT, { ...payload, agent_id: 'unrelated-agent' }), null);
  assert.equal(runHookOutput(GUARD_SHARED_TREE_COMMIT, payload, {
    CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'missing-sidequest-plugin'),
  }), null);
});

test('pre-tool hook: every stable readonly executor remains allowed and forced to bypass', () => {
  for (const effort of EFFORTS) {
    const claude = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: stableReadOnlyClaudeName(effort),
        model: 'sonnet',
        prompt: `Review SQ-1 at ${effort} effort.`,
      },
    });
    assert.equal(claude.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(claude.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

    const dispatch = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: stableReadOnlyDispatchName(effort),
        model: 'fable',
        prompt: `Review SQ-1.\n[sidequest-route model=gpt-5.6-sol effort=${effort}]`,
      },
    });
    assert.equal(dispatch.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(dispatch.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
    assert.equal(dispatch.hookSpecificOutput.updatedInput.model, undefined);
  }
});

test('pre-tool hook: native Explore and approved harness utilities pass through unchanged', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'statusline-setup']) {
    assert.equal(runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: { subagent_type, isolation: 'worktree', prompt: 'Read-only reconnaissance.' },
    }), null, subagent_type);
  }
});

test('pre-tool hook: arbitrary implementation agents are denied and directed to ticketed routes', () => {
  for (const [subagent_type, prompt] of [
    ['web-researcher', 'Research the latest routing guidance.'],
    ['implementation-agent', 'Implement the new flow.'],
  ]) {
    const out = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: { subagent_type, isolation: 'worktree', prompt },
    });
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', subagent_type);
    assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
    assert.match(reason, /Read, Glob, Grep, or WebFetch inline, not WebSearch/);
    assert.match(reason, /WebSearch is executor-only: file and dispatch a research ticket/);
    assert.match(reason, /quick investigation, needs a ticket: file a spike/);
    assert.match(reason, /codebase-exploration/);
    assert.match(reason, /route it, dispatch it, then spawn the returned executor/);
    assert.match(reason, /blocked work still gates any dependent action/);
    assert.match(reason, /do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed/);
    assert.match(reason, /rerouting around this block is a violation/);
    assert.doesNotMatch(reason, /fresh dispatch briefing/);
  }
  const mismatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-invalid', isolation: 'worktree', prompt: 'Quick lookup.' },
  });
  assert.equal(mismatch.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    mismatch.hookSpecificOutput.permissionDecisionReason,
    'sidequest: sidequest-invalid is an unknown Sidequest agent type. Use the executor returned by dispatch.'
  );
  assert.doesNotMatch(mismatch.hookSpecificOutput.permissionDecisionReason, /update\+reload|version mismatch/);
  const malformedExecutor = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-readonly-ultra', prompt: 'Quick lookup.' },
  });
  assert.match(malformedExecutor.hookSpecificOutput.permissionDecisionReason, /looks like a Sidequest executor name but is invalid or retired/);
  assert.doesNotMatch(malformedExecutor.hookSpecificOutput.permissionDecisionReason, /update\+reload|version mismatch/);
  assert.doesNotMatch(mismatch.hookSpecificOutput.permissionDecisionReason, new RegExp(RETIRED_SCOUT));
});

test('pre-tool hook: executor helpers allow mechanical sweeps with parent-tree safeguards', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']) {
    const out = runHookOutput(FORCE_BYPASS, {
      agent_id: `native-task@${subagent_type}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type,
        model: 'haiku',
        isolation: 'worktree',
        run_in_background: false,
        prompt: 'Locate matching test fixtures in the parent worktree without editing.',
      },
    });
    assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku', subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions', subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true, subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.isolation, undefined, subagent_type);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /quoted ticket strings appear in this session’s context/);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /self-reference, not evidence/);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /report a visibility block rather than a finding/);
    assert.match(out.systemMessage, /background from the parent working tree/);
    assert.match(out.systemMessage, /report the visibility block instead of returning clean findings/);
  }
});

test('pre-tool hook: helper session transcript hits are self-reference', () => {
  const transcriptPath = path.join(os.tmpdir(), 'sq-current-session.jsonl');
  const out = runHookOutput(FORCE_BYPASS, {
    agent_id: 'evidence-helper',
    agent_type: 'sidequest-exec-dispatch',
    transcript_path: transcriptPath,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', model: 'haiku', prompt: 'Find quoted evidence.' },
  });
  const prompt = out.hookSpecificOutput.updatedInput.prompt;
  assert.match(prompt, /self-reference, not evidence/);
  assert.match(prompt, /report it as such/);
  assert.match(prompt, /Current session self-reference locations:/);
  assert.ok(prompt.includes(transcriptPath));
  assert.ok(prompt.includes(path.join(path.dirname(transcriptPath), 'subagents')));
});

test('pre-tool hook: executor helpers reject review work and model defaults', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']) {
    const review = runHookOutput(FORCE_BYPASS, {
      agent_id: `review-helper-${subagent_type}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type,
        model: 'haiku',
        isolation: 'worktree',
        description: 'Inspect the parent work.',
        prompt: 'Audit the ticket-scoped storage API.',
      },
    });
    assert.equal(review.hookSpecificOutput.permissionDecision, 'deny', subagent_type);
    assert.match(review.hookSpecificOutput.permissionDecisionReason, /review-audit/, subagent_type);
    assert.doesNotMatch(review.hookSpecificOutput.permissionDecisionReason, /Use Explore|claude-code-guide|web-researcher/, subagent_type);
  }

  for (const prompt of ['Audits the ticket-scoped storage API.', 'Reviews the ticket-scoped storage API.']) {
    const review = runHookOutput(FORCE_BYPASS, {
      agent_id: `plural-review-helper-${prompt[0]}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', model: 'haiku', prompt },
    });
    assert.equal(review.hookSpecificOutput.permissionDecision, 'deny', prompt);
    assert.match(review.hookSpecificOutput.permissionDecisionReason, /review-audit/, prompt);
  }

  const reviewDescription = runHookOutput(FORCE_BYPASS, {
    agent_id: 'review-description-helper',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'general-purpose',
      model: 'haiku',
      description: 'Act as a reviewer for the parent work.',
      prompt: 'Locate the relevant test fixture.',
    },
  });
  assert.equal(reviewDescription.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reviewDescription.hookSpecificOutput.permissionDecisionReason, /review-audit/);

  const defaulted = runHookOutput(FORCE_BYPASS, {
    agent_id: 'defaulted-helper',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'Read the parent diff.' },
  });
  assert.equal(defaulted.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(defaulted.hookSpecificOutput.permissionDecisionReason, /needs an explicit Agent model/);
  assert.match(defaulted.hookSpecificOutput.permissionDecisionReason, /do not inherit the parent route/);

  const chained = runHookOutput(FORCE_BYPASS, {
    agent_id: 'already-running-helper',
    agent_type: 'general-purpose',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', model: 'haiku', prompt: 'Read the parent diff.' },
  });
  assert.equal(chained.hookSpecificOutput.updatedInput.run_in_background, true);

  const mainThread = runHookOutput(FORCE_BYPASS, {
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'Quick lookup.' },
  });
  assert.equal(mainThread.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mainThread.hookSpecificOutput.permissionDecisionReason, /generic Agent, not a Sidequest ticket executor/);
});

test('pre-tool hook: a generated per-ticket executor definition owns its ticket by name', () => {
  // A per-ticket definition spawns under the dispatch's agentName as its subagent_type, and
  // its runtime id never binds, so matching on agentId alone refused every edit it made
  // (contractify, 2026-08-05: two executors blocked identically, wave stalled).
  const ticket = addStopTicket('generated definition scope', { files: ['lib/allowed.js'] });
  const sessionId = `generated-definition-${++sqSeq}`;
  // A second live ticket in the same session is what makes this bite: with only one,
  // the sole-active-ticket fallback masks a failed identity match (contractify ran
  // SQ-64 and SQ-85 concurrently).
  claimStopTicket(addStopTicket('concurrent generated sibling', { files: ['lib/sibling.js'] }), sessionId, 'generated-sibling');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const agentName = `asq-${ticket.id}-generated-${sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'generated-definition-claim', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', `agent-${agentName}`);
  // The runtime name is DERIVED from the launch name: "a" + name + "-" + hash.
  const runtimeName = `a${agentName}-207bbcf0be435ec2`;
  const acting = { session_id: sessionId, agent_type: runtimeName, agent_id: runtimeName, cwd: worktree };

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...acting,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  }), null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...acting,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'elsewhere.js') },
  });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /effective scope/);
});

test('pre-tool hook: an unbound helper inherits the sole active ticket', () => {
  // The helper's own id never binds to a dispatch. With exactly one active ticket in the
  // session there is nothing to borrow from, so refusing it only blocked legitimate work.
  const ticket = addStopTicket('sole active helper scope', { files: ['lib/allowed.js'] });
  const sessionId = `sole-active-helper-${++sqSeq}`;
  const parent = claimStopTicket(ticket, sessionId, 'sole-active-parent');
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', 'sq-sole-active');
  const helper = {
    ...parent,
    agent_type: 'general-purpose',
    agent_id: `unbound-helper-${++sqSeq}`,
    cwd: worktree,
  };

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  }), null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'elsewhere.js') },
  });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /effective scope/);
});

test('pre-tool hook: a steer between turns is delivered, but a terminal failure is recorded', () => {
  const ticket = addStopTicket('late steer capture', { files: ['lib/allowed.js'] });
  const sessionId = `late-steer-${++sqSeq}`;
  const acting = claimStopTicket(ticket, sessionId, 'late-steer-worker');
  assert.equal(store.markDispatchStopped(sessionId, acting.agent_type, acting.agent_id, acting.agent_name).ok, true);

  const steer = {
    session_id: sessionId,
    agent_id: 'orchestrator-late-steer',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Prefer type filters over content search.' },
  };
  assert.equal(runHookOutput(FORCE_BYPASS, steer), null);

  const dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: store.getTicket(slug, ticket.ref).dispatchNonce,
    executor: dispatch.executor,
    error: 'Prompt is too long',
  }).ok, true);
  const denied = runHookOutput(FORCE_BYPASS, steer);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, new RegExp(ticket.ref));
  assert.match(reason, /now a comment on the ticket/);
  assert.match(reason, /Re-dispatch/);

  const bodies = store.getTicket(slug, ticket.ref).comments.map((comment: any) => comment.body);
  assert.ok(bodies.some((body: string) => /Late steer/.test(body) && /Prefer type filters over content search\./.test(body)), bodies.join(' | '));
});

test('pre-tool hook: a steer to a live executor is untouched', () => {
  const ticket = addStopTicket('live steer passthrough', { files: ['lib/allowed.js'] });
  const sessionId = `live-steer-${++sqSeq}`;
  const acting = claimStopTicket(ticket, sessionId, 'live-steer-worker');

  assert.equal(runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    agent_id: 'orchestrator-live-steer',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Check the fixture before you commit.' },
  }), null);

  assert.equal(runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    agent_id: 'orchestrator-live-steer',
    tool_name: 'SendMessage',
    tool_input: { to: 'some-unrelated-teammate', message: 'Ping.' },
  }), null);
});

test('executor template calls transcript evidence self-reference', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'scripts', '_exec-template.md'), 'utf8');
  assert.match(template, /Evidence work that needs session, transcript, or task-output searching is not helper work/);
  assert.match(template, /a match there is self-reference, not evidence/);
  assert.match(template, /report a visibility block rather than a finding/);
});

test('pre-tool hook: helper writes use the bound agent scope in linked worktrees', () => {
  const parentTicket = addStopTicket('helper scope capability', { files: ['lib/allowed.js'] });
  const sessionId = `helper-scope-${++sqSeq}`;
  const parent = claimStopTicket(parentTicket, sessionId, 'helper-parent');
  const siblingTicket = addStopTicket('concurrent helper scope', { files: ['lib/sibling.js'] });
  claimStopTicket(siblingTicket, sessionId, 'helper-sibling');
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', 'sq-538-river-bluffs');
  const helper = {
    ...parent,
    agent_type: 'general-purpose',
    cwd: worktree,
  };
  const inside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  });
  assert.equal(inside, null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'sibling.js') },
  });
  const reason = outside.hookSpecificOutput.permissionDecisionReason;
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /lib[\\/]sibling\.js/);
  assert.match(reason, new RegExp(parentTicket.ref));
  assert.doesNotMatch(reason, new RegExp(siblingTicket.ref));
  assert.match(reason, /effective scope/);

  const unbound = runHookOutput(FORCE_BYPASS, {
    ...helper,
    agent_id: `unbound-helper-${sqSeq}`,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'outside.js') },
  });
  assert.equal(unbound.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(unbound.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);
  assert.doesNotMatch(unbound.hookSpecificOutput.permissionDecisionReason, new RegExp(parentTicket.ref));
  assert.doesNotMatch(unbound.hookSpecificOutput.permissionDecisionReason, new RegExp(siblingTicket.ref));

  const scratchpad = path.join(os.tmpdir(), 'claude', `helper-scratchpad-${sqSeq}`, 'temp.js');
  const scratchpadWrite = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: scratchpad },
  });
  assert.equal(scratchpadWrite, null);

  const read = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Read',
    tool_input: { file_path: path.join(worktree, 'lib', 'outside.js') },
  });
  assert.equal(read, null);
});

test('pre-tool hook: an unbound helper can restore only one declared file to HEAD', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-helper-revert-'));
  fs.mkdirSync(path.join(projectPath, 'lib'));
  const allowedPath = path.join(projectPath, 'lib', 'allowed.js');
  const outsidePath = path.join(projectPath, 'lib', 'outside.js');
  const committedContent = 'export const guard = true;\n';
  fs.writeFileSync(allowedPath, committedContent);
  fs.writeFileSync(outsidePath, committedContent);
  gitFixture(['init', '--quiet'], projectPath);
  gitFixture(['config', 'user.email', 'sidequest@example.invalid'], projectPath);
  gitFixture(['config', 'user.name', 'Sidequest Tests'], projectPath);
  gitFixture(['add', 'lib/allowed.js', 'lib/outside.js'], projectPath);
  gitFixture(['commit', '--quiet', '-m', 'fixture'], projectPath);
  fs.writeFileSync(allowedPath, 'export const guard = false;\n');
  fs.writeFileSync(outsidePath, 'export const guard = false;\n');

  const project = store.ensureProject(projectPath).slug;
  const parent = store.createTicket(project, { title: 'revert owner', category: 'debugging', files: ['lib/allowed.js'], source: 'cli' });
  const sibling = store.createTicket(project, { title: 'revert sibling', category: 'debugging', files: ['lib/sibling.js'], source: 'cli' });
  const sessionId = `helper-revert-${++sqSeq}`;
  for (const [ticket, agentName] of [[parent, 'revert-owner'], [sibling, 'revert-sibling']] as const) {
    const prepared = store.prepareDispatch(project, ticket.ref, { sessionId, sharedTree: true });
    assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
      sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, `${agentName}-id`, agentName).ok, true);
    assert.equal(store.claimTicket(project, ticket.ref, `${agentName}-claim`, {
      sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
  }

  const unbound = {
    session_id: sessionId,
    agent_id: `unbound-helper-${sqSeq}`,
    agent_type: 'general-purpose',
    cwd: projectPath,
    tool_name: 'Write',
    tool_input: { file_path: allowedPath, content: committedContent },
  };
  const editRestore = runHookOutput(FORCE_BYPASS, {
    ...unbound,
    tool_name: 'Edit',
    tool_input: { file_path: allowedPath, old_string: 'export const guard = false;\n', new_string: committedContent },
  });
  assert.equal(editRestore, null);
  assert.equal(runHookOutput(FORCE_BYPASS, unbound), null);
  assert.deepEqual(Buffer.from(unbound.tool_input.content), execFileSync('git', ['show', 'HEAD:lib/allowed.js'], { cwd: projectPath }));

  const smuggled = runHookOutput(FORCE_BYPASS, {
    ...unbound,
    tool_input: { file_path: allowedPath, content: 'export const guard = "smuggled";\n' },
  });
  assert.equal(smuggled.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(smuggled.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);

  if (process.platform === 'win32') {
    const aliasProjectPath = windowsShortPath(projectPath);
    if (aliasProjectPath.toLowerCase() !== projectPath.toLowerCase()) {
      const aliasAllowed = runHookOutput(FORCE_BYPASS, {
        ...unbound,
        tool_input: { file_path: path.join(aliasProjectPath, 'lib', 'allowed.js'), content: committedContent },
      });
      assert.equal(aliasAllowed, null);

      const aliasOutside = runHookOutput(FORCE_BYPASS, {
        ...unbound,
        tool_input: { file_path: path.join(aliasProjectPath, 'lib', 'outside.js'), content: committedContent },
      });
      assert.equal(aliasOutside.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(aliasOutside.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);
    }
  }
});

test('pre-tool hook: ordinary subagents without a dispatch stay outside the helper scope guard', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    session_id: `ordinary-${++sqSeq}`,
    agent_id: `ordinary-helper-${sqSeq}`,
    agent_type: 'general-purpose',
    tool_name: 'Write',
    tool_input: { file_path: path.join(BOARD_PATH, 'outside.js') },
  });
  assert.equal(out, null);
});

test('pre-tool hook: a marked arbitrary agent is still denied', () => {
  const marked = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'implementation-agent',
      isolation: 'worktree',
      prompt: ` \n\t[${RETIRED_SCOUT}]\nImplement the change.`,
    },
  });
  const reason = marked.hookSpecificOutput.permissionDecisionReason;
  assert.equal(marked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
  assert.match(reason, /file a spike/);
  assert.match(reason, /returned executor/);
});

test('pre-tool hook keeps builtin models and strips a stable dispatch executor model', () => {
  const dispatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'sq210-dispatch',
      prompt: 'work SQ-210\n[sidequest-route model=codex-gpt-5-6-terra effort=high]',
    },
  });
  assert.equal(dispatch.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(dispatch.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(dispatch.systemMessage, /removed the Agent model override/);

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'sq210-builtin' },
  });
  assert.equal(builtIn.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const haiku = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-medium', model: 'haiku', name: 'sq210-haiku' },
  });
  assert.equal(haiku.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(haiku.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  for (const subagent_type of ['sidequest-native-sq-210-gpt-5-6-terra', 'sidequest-ticket-sq-584-haiku-b37fffcb']) {
    const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: { subagent_type, prompt: 'work SQ-210' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /unknown Sidequest agent type|invalid or retired/);
  }
});

test('pre-tool hook: malformed input fails soft', () => {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: '{"tool_input":',
    encoding: 'utf8',
    env: process.env,
  });
  assert.strictEqual(out, '');
});

test('task-output guard: blocks Sidequest native task identities and dispatched names', () => {
  const reason = 'native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.';
  const direct = runHookOutput(GUARD_TASK_OUTPUT, {
    tool_name: 'TaskOutput', tool_input: { task_id: 'sidequest-exec-dispatch@session-abc' },
  });
  assert.equal(direct.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(direct.hookSpecificOutput.permissionDecisionReason, new RegExp(reason.replace(/[<>]/g, '\\$&')));

  const ticket = fixtureTicket('task-output mapped launch', 'sonnet', 'high');
  const sessionId = `task-output-${Date.now()}`;
  const agentName = 'friendly-launch-name';
  const agentId = 'native-task@session-sidequest-guard';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);

  for (const tool_input of [{ task_id: agentName }, { id: agentId }]) {
    const out = runHookOutput(GUARD_TASK_OUTPUT, { session_id: sessionId, tool_name: 'TaskOutput', tool_input });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('task-output guard: leaves background task IDs and malformed unrelated input alone', () => {
  for (const tool_input of [
    { task_id: 'build-123' },
    { id: 'unrelated-SQ-439-process' },
    { task_id: {} },
  ]) {
    assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, { tool_name: 'TaskOutput', tool_input }), null);
  }
});

test('task-output guard: executor identity variants bypass the main-thread guard', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, {
      tool_name: 'TaskOutput', ...identity, tool_input: { task_id: 'sidequest-exec-dispatch@session-abc' },
    }), null);
  }
});

test('pre-tool hook warns at the soft threshold, then escalates inside the final band', () => {
  const agentId = `near-cap-${Date.now()}`;
  const payload = { tool_name: 'Read', agent_type: 'sidequest-exec-high', agent_id: agentId, effort: 'high' };
  const run = () => execFileSync(process.execPath, [NEAR_TURN_CAP], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, SIDEQUEST_EXEC_MAX_TURNS: '1' },
  });
  // cap=1 → soft threshold 1, final band starts at 2, re-warn every 4 calls.
  assert.match(JSON.parse(run()).hookSpecificOutput.additionalContext, /made 1 tool calls/);
  assert.match(JSON.parse(run()).hookSpecificOutput.additionalContext, /TURN CAP IMMINENT/);
  assert.equal(run(), '', 'call 3 is inside the re-warn cooldown');
  assert.equal(run(), '', 'call 4 is inside the re-warn cooldown');
  assert.equal(run(), '', 'call 5 is inside the re-warn cooldown');
  assert.match(JSON.parse(run()).hookSpecificOutput.additionalContext, /TURN CAP IMMINENT/, 'the imperative repeats until the executor stops');
});

test('pre-tool hook soft warning fires on crossing the threshold, once', () => {
  const agentId = `near-cap-cross-${Date.now()}`;
  const counter = path.join(os.tmpdir(), 'sidequest-near-turn-cap', encodeURIComponent(agentId));
  fs.mkdirSync(path.dirname(counter), { recursive: true });
  const run = () => execFileSync(process.execPath, [NEAR_TURN_CAP], {
    input: JSON.stringify({ tool_name: 'Read', agent_type: 'sidequest-exec-high', agent_id: agentId, effort: 'high' }),
    encoding: 'utf8', env: { ...process.env },
  });
  // high effort → cap 150, soft threshold 120, final band from 135.
  fs.writeFileSync(counter, '119 0');
  assert.match(JSON.parse(run()).hookSpecificOutput.additionalContext, /near its 150-turn backstop/);
  assert.equal(run(), '', 'no duplicate soft warning after the crossing');
  fs.writeFileSync(counter, '134 0');
  assert.match(JSON.parse(run()).hookSpecificOutput.additionalContext, /TURN CAP IMMINENT — 135 tool calls against a 150-turn hard cap/);
});

test('pre-tool near-cap hook ignores main-thread and unrelated subagent calls', () => {
  assert.equal(runHookOutput(NEAR_TURN_CAP, { tool_name: 'Read', agent_id: 'main-thread' }), null);
  assert.equal(runHookOutput(NEAR_TURN_CAP, { tool_name: 'Read', agent_type: 'explore', agent_id: 'other-agent' }), null);
});

test('pre-tool repeated-command hook ignores main-thread and unrelated subagent calls', () => {
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { tool_name: 'Bash', agent_id: 'main-thread', tool_input: { command: 'npm test' } }), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { tool_name: 'Bash', agent_type: 'explore', agent_id: 'other-agent', tool_input: { command: 'npm test' } }), null);
});

test('pre-tool repeated-command hook warns on the third repeat and every fifth after', () => {
  const agentId = `repeated-command-${Date.now()}`;
  const payload = { tool_name: 'Bash', agent_type: 'sidequest-exec-high', agent_id: agentId, tool_input: { command: 'npm   run\n test' } };
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run test' } }), null);
  const third = runHook(REPEATED_COMMAND_WARN, payload);
  assert.equal(third, 'sidequest: you have run this exact command 3 times; if you are waiting on something, run it with run_in_background and let the completion notification wake you — polling burns ~14s and ~60k tokens per call');
  for (let i = 0; i < 4; i += 1) assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, payload), /you have run this exact command 3 times/);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), /you have run this exact command 3 times/);
});

test('pre-tool repeated-command hook warns for PowerShell commands', () => {
  const agentId = `repeated-command-powershell-${Date.now()}`;
  const payload = { tool_name: 'PowerShell', agent_type: 'sidequest-exec-high', agent_id: agentId, tool_input: { command: 'npm test' } };
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, payload), /polling burns ~14s and ~60k tokens per call/);
});

test('pre-tool inline-work hook records activity without injecting repeat reminders', () => {
  const session_id = `inline-advisory-${Date.now()}`;
  for (let i = 0; i < 20; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: i % 2 ? 'Read' : 'Write', tool_input: {},
    }), null);
  }
});

test('pre-tool inline-work nudge stays quiet after a board interaction', () => {
  const session_id = `inline-board-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: {},
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    }), null);
  }
  const cliSession = `inline-cli-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Bash',
    tool_input: { command: 'node "C:/plugins/sidequest/bin/sidequest.js" list' },
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Glob', tool_input: {},
    }), null);
  }
});

test('pre-tool inline-work nudge ignores subagent identity variants and routing-disabled boards', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    const subagent = { session_id: `inline-subagent-${Date.now()}`, cwd: BOARD_PATH, ...identity, tool_name: 'Read', tool_input: {} };
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `inline-disabled-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {} };
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

test('pre-tool inline-work nudge ignores automation prompts', () => {
  const payload = {
    session_id: `inline-automation-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    prompt: '<task-notification>Executor completed.</task-notification>',
  };
  for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
});

test('user-prompt reminder fires once for the first human prompt', () => {
  const payload = { session_id: `board-first-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Fix the board hook.' };
  const reminder = runHookOutput(BOARD_FIRST_REMINDER, payload);
  assert.equal(reminder.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(reminder.hookSpecificOutput.additionalContext, /gather enough read-only evidence or use Explore/);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, payload), null);
});

test('user-prompt reminder ignores automation without consuming the session flag', () => {
  const payload = { session_id: `board-automation-${Date.now()}`, cwd: BOARD_PATH };
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<task-notification>Executor completed.</task-notification>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<agent-message>Worker needs input.</agent-message>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command>Command output.</local-command>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command-caveat>Command output.</local-command-caveat>' }), null);
  assert.match(runHook(BOARD_FIRST_REMINDER, { ...payload, prompt: 'Implement the ticket.' }), /Use informed inline judgment/);
});

test('user-prompt reminder ignores subagent identity variants and routing-disabled boards', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    const subagent = { session_id: `board-subagent-${Date.now()}`, cwd: BOARD_PATH, ...identity, prompt: 'Implement the ticket.' };
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `board-disabled-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Implement the ticket.' };
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

/* ------------------------------------------------------------------ *
 *  Builtin executors spawned WITHOUT a model must not silently inherit
 *  the session model — resolve the routed model from a ref in the prompt,
 *  or deny the spawn when it can't be resolved unambiguously (SQ-232).
 * ------------------------------------------------------------------ */

let fixtureSeq = 0;
function fixtureTicket(title?: any, model?: any, effort?: any) {
  const category = `hooks-route-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model, effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, { title, category, source: 'cli' });
}

test('pre-tool hook keeps a complete Claude worktree spawn valid outside its board cwd', () => {
  const ticket = fixtureTicket('SQ-399 worktree spawn regression', 'fable', 'xhigh');
  const unregisteredWorktree = path.join(os.tmpdir(), 'sq-unregistered-worktree');
  const original = {
    subagent_type: 'sidequest-exec-xhigh',
    name: 'sq399-worktree',
    mode: 'bypassPermissions',
    isolation: 'worktree',
    model: 'fable',
    prompt: `Implement ${ticket.ref}. --project "${path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board')}"`,
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', cwd: unregisteredWorktree, tool_input: original });

  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, original);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});
test('pre-tool hook: builtin exec without a model injects the resolved Claude model from a prompt ref', () => {
  const t = fixtureTicket('SQ-232 inject fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-inject', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'a resolvable spawn must not be denied');
  assert.match(out.systemMessage, /injected "sonnet"/);
  assert.match(out.systemMessage, /resolved category route/);
  assert.ok(out.systemMessage.includes(t.ref), 'systemMessage must name the ref it resolved from');
});

test('pre-tool hook: builtin exec without a model and no ticket ref in the prompt is denied', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-norefs', prompt: 'go fix the reporter, no ticket named here' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ready --brief/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /model: exec\.model/);
});

test('pre-tool hook: builtin exec without a model and conflicting concrete models across refs is denied', () => {
  const a = fixtureTicket('SQ-232 conflict fixture A', 'sonnet', 'high');
  const b = fixtureTicket('SQ-232 conflict fixture B', 'opus', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-conflict', prompt: `batch ${a.ref} and ${b.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /conflicting concrete models/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /split it per model/);
});

test('pre-tool hook: builtin exec spawned WITH a model that mismatches the resolved route keeps the caller value and warns', () => {
  const t = fixtureTicket('SQ-232 mismatch fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-mismatch', model: 'opus', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'opus', 'a deliberate cap must be kept, not overwritten');
  assert.match(out.systemMessage, /model "opus" but .* resolves to "sonnet"/);
});

test('pre-tool hook: stable dispatch executor strips model even when a ref resolves', () => {
  const t = fixtureTicket('SQ-232 dispatch passthrough fixture', 'codex-gpt-5-6-terra', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'w-dispatch',
      prompt: `work ${t.ref} --project "${slug}"\n[sidequest-route model=codex-gpt-5-6-terra effort=high]`,
    },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(out.systemMessage, /removed the Agent model override/);
});



/* ------------------------------------------------------------------ *
 *  CLAUDE_CODE_SUBAGENT_MODEL defeats routing (it overrides both the Agent
 *  model and the frontmatter pin) — so a sidequest executor spawn must be
 *  denied while it's set, not run on the wrong model.
 * ------------------------------------------------------------------ */

function runForceBypassWithEnv(toolInput?: any, envOverrides?: any) {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a dispatch executor spawn', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'sq-env-codex', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /CLAUDE_CODE_SUBAGENT_MODEL/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /defeat(s|ing) routing/);
});

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a builtin executor spawn too', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-high', name: 'sq-env-builtin', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Unset it/);
});

test('pre-tool hook: an unset CLAUDE_CODE_SUBAGENT_MODEL leaves the spawn alone', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'sq-env-off', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: '' }
  );
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'no override -> no deny');
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined, 'the pin still wins by stripping the Agent model');
});

/* ------------------------------------------------------------------ *
 *  Peer-message guard — an executor reports UP (final message + its own
 *  ticket comments), never sideways to a peer. This is the other half of
 *  the Contractify loop.
 * ------------------------------------------------------------------ */

function runGuardPeer(payload?: any) {
  const out = execFileSync(process.execPath, [GUARD_PEER], {
    input: JSON.stringify({ tool_name: 'SendMessage', ...payload }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('peer-guard: executor and Codex executor peer messages are allowed', () => {
  for (const agent_type of ['sidequest-exec-high', 'sidequest-exec-codex-gpt-5-6-luna-medium']) {
    assert.strictEqual(runGuardPeer({ agent_type, tool_input: { to: 'reviewer', message: 'look at SQ-70' } }), null);
  }
});

test('peer-guard: an executor reporting to main is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'sidequest-exec-high', tool_input: { to: 'main', message: 'done' } }), null);
});

test('peer-guard: a main-thread SendMessage (no agent_type) is allowed', () => {
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'reviewer', message: 'assign' } }), null);
});

test('peer-guard: terminal dispatch blocks delayed steering before delivery', () => {
  const ticket = addEffortTicket('terminal executor cannot be revived', 'high');
  const sessionId = `terminal-message-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executorName = 'finished-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'terminal-agent-id', executorName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'terminal-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    error: 'Prompt is too long',
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim.by, 'terminal-worker');
  assert.equal(after.dispatch.agentName, executorName, 'terminal failures retain the mapped executor for terminal cleanup');
  assert.equal(after.dispatch.outcome, 'died');
  assert.ok(after.dispatch.terminalAt);

  const out = runGuardPeer({ tool_input: { to: executorName, message: 'one more thing' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
});

test('peer-message hooks refuse a completed executor by its exact SendMessage target', () => {
  const ticket = addStopTicket('completed executor cannot receive follow-up work');
  const acting = claimStopTicket(ticket, `completed-message-${++sqSeq}`, 'completed-worker');
  assert.equal(store.completeTicket(slug, ticket.ref, 'completed-worker', {
    model: 'sonnet',
    effort: 'high',
    cleanDeclaredScope: true,
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.status, 'done');
  assert.equal(after.claim, null);
  assert.equal(after.dispatch.outcome, 'done');

  const payload = {
    agent_id: 'orchestrator-after-completion',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Make one more revision.' },
  };
  for (const hook of [GUARD_PEER, FORCE_BYPASS]) {
    const out = runHookOutput(hook, payload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
  }
});

test('peer-message hooks refuse a submitted executor by its exact SendMessage target', () => {
  const ticket = addStopTicket('submitted executor cannot receive follow-up work');
  const acting = claimStopTicket(ticket, `submitted-message-${++sqSeq}`, 'submitted-worker');
  assert.equal(store.submitTicket(slug, ticket.ref, 'submitted-worker', {
    commit: 'a'.repeat(40),
    range: {
      base: 'b'.repeat(40),
      upstream: 'main',
      upstreamCommit: 'c'.repeat(40),
      commits: [],
      changedPaths: [],
      noOp: true,
    },
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim, null);
  assert.equal(after.dispatch.outcome, 'submitted');

  const payload = {
    agent_id: 'orchestrator-after-submission',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Make one more revision.' },
  };
  for (const hook of [GUARD_PEER, FORCE_BYPASS]) {
    const out = runHookOutput(hook, payload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
  }
});

test('peer-guard: missing isolated worktree blocks a non-terminal resume only', () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-missing-worktree-'));
  fs.writeFileSync(path.join(isolatedRoot, 'fixture.txt'), 'fixture\n');
  gitFixture(['init'], isolatedRoot);
  gitFixture(['config', 'user.email', 'sidequest@example.test'], isolatedRoot);
  gitFixture(['config', 'user.name', 'Sidequest Test'], isolatedRoot);
  gitFixture(['add', 'fixture.txt'], isolatedRoot);
  gitFixture(['commit', '-m', 'fixture'], isolatedRoot);
  const { slug: isolatedSlug } = store.ensureProject(isolatedRoot);
  const category = 'general';
  const isolated = store.createTicket(isolatedSlug, { title: 'missing worktree cannot be resumed', category, files: ['lib'], source: 'cli' });
  const sessionId = `missing-worktree-${++sqSeq}`;
  const prepared = store.prepareDispatch(isolatedSlug, isolated.ref, { sessionId, sharedTree: false });
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  const isolatedName = 'missing-worktree-worker';
  const agentId = `missing-worktree-agent-${sqSeq}`;
  assert.equal(store.recordDispatchLaunch(isolatedSlug, isolated.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: isolatedName,
  }).ok, true);
  const worktree = path.join(isolatedRoot, '.claude', 'worktrees', `agent-${agentId}`);
  fs.mkdirSync(worktree, { recursive: true });
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, isolatedName).ok, true);
  assert.strictEqual(runGuardPeer({ tool_input: { to: isolatedName, message: 'continue' } }), null);
  fs.rmSync(worktree, { recursive: true, force: true });

  const blocked = runGuardPeer({ tool_input: { to: isolatedName, message: 'continue' } });
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(isolated.ref));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /worktree-isolated/);
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /Redispatch/);

  const shared = store.createTicket(isolatedSlug, { title: 'shared worker remains reachable', category, files: ['lib'], source: 'cli' });
  const sharedSession = `shared-worktree-${++sqSeq}`;
  const sharedPrepared = store.prepareDispatch(isolatedSlug, shared.ref, { sessionId: sharedSession, sharedTree: true });
  assert.equal(sharedPrepared.ticket.dispatch.sharedTree, true);
  assert.equal(store.recordDispatchLaunch(isolatedSlug, shared.ref, {
    sessionId: sharedSession,
    token: sharedPrepared.token,
    executor: sharedPrepared.ticket.dispatchExecutor,
    agentName: 'shared-worktree-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sharedSession, sharedPrepared.ticket.dispatchExecutor, `shared-agent-${sqSeq}`, 'shared-worktree-worker').ok, true);
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'shared-worktree-worker', message: 'continue' } }), null);
  assert.equal(store.deleteProjectExact(isolatedSlug).ok, true);
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
});

test('teammate-idle: terminal dispatch ends its own idle executor', () => {
  const ticket = addEffortTicket('terminal teammate exits', 'high');
  const sessionId = `terminal-idle-${++sqSeq}`;
  const stop = claimStopTicket(ticket, sessionId, 'terminal-idle-worker');
  assert.equal(store.completeTicket(slug, ticket.ref, 'terminal-idle-worker', { sessionId }).ok, true);

  const out = runHookOutput(TEAMMATE_IDLE, {
    hook_event_name: 'TeammateIdle',
    session_id: 'teammate-own-session',
    agent_id: stop.agent_id,
    agent_type: stop.agent_type,
    teammate_name: stop.agent_name,
  });
  assert.deepEqual(out, {
    continue: false,
    stopReason: `sidequest: ${ticket.ref} is terminal (done); end this idle executor.`,
  });
});

test('teammate-idle: live and scope-paused claims remain alive', () => {
  const live = addEffortTicket('live teammate remains', 'high');
  const liveStop = claimStopTicket(live, `live-idle-${++sqSeq}`, 'live-idle-worker');
  assert.equal(runHookOutput(TEAMMATE_IDLE, {
    hook_event_name: 'TeammateIdle',
    session_id: liveStop.session_id,
    agent_id: liveStop.agent_id,
    agent_type: liveStop.agent_type,
    teammate_name: liveStop.agent_name,
  }), null);

  const paused = addStopTicket('scope-paused teammate remains', { files: ['lib/declared.js'] });
  const pausedStop = claimStopTicket(paused, `paused-idle-${++sqSeq}`, 'paused-idle-worker');
  assert.equal(store.requestScope(slug, paused.ref, 'paused-idle-worker', ['lib/resumed.js']).ok, true);
  runHook(SUBAGENT_STOP, pausedStop);
  assert.equal(runHookOutput(TEAMMATE_IDLE, {
    hook_event_name: 'TeammateIdle',
    session_id: pausedStop.session_id,
    agent_id: pausedStop.agent_id,
    agent_type: pausedStop.agent_type,
    teammate_name: pausedStop.agent_name,
  }), null);
});

test('peer-guard: an executor between turns accepts steering before and after scope approval', () => {
  const ticket = addStopTicket('scope-paused executor resumes', { files: ['lib/declared.js'] });
  const sessionId = `scope-pause-message-${++sqSeq}`;
  const stop = claimStopTicket(ticket, sessionId, 'scope-paused-worker');
  assert.equal(store.requestScope(slug, ticket.ref, 'scope-paused-worker', ['lib/resumed.js']).ok, true);

  assert.equal(
    runHook(SUBAGENT_STOP, stop),
    `exec WAITING: ${ticket.ref} has a pending scope request; approve scope, then resume it from the recovery snapshot`,
  );
  const paused = store.getTicket(slug, ticket.ref);
  assert.equal(paused.dispatch.outcome, 'claimed');
  assert.equal(paused.dispatch.terminalAt, null);
  assert.equal(store.claimReleaseVerdict(paused), null, 'an open scope request keeps its claim');
  assert.strictEqual(runGuardPeer({ tool_input: { to: stop.agent_name, message: 'scope is approved' } }), null);

  store.updateTicket(slug, ticket.ref, { files: ['lib/declared.js', 'lib/resumed.js'] });
  const resumed = store.getTicket(slug, ticket.ref);
  assert.equal(resumed.scopeRequest, null);
  assert.equal(resumed.dispatch.outcome, 'claimed');
  assert.equal(resumed.dispatch.terminalAt, undefined);
  assert.equal(resumed.dispatch.agentName, stop.agent_name);
  assert.strictEqual(runGuardPeer({ tool_input: { to: stop.agent_name, message: 'resume the approved work' } }), null);
});

test('peer-guard: an active dispatch still accepts main-thread steering', () => {
  const ticket = addEffortTicket('active executor accepts steering', 'high');
  const sessionId = `active-message-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executorName = 'active-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);

  assert.strictEqual(runGuardPeer({ tool_input: { to: executorName, message: 'please check the test' } }), null);
});

test('peer-guard: a non-sidequest subagent messaging a peer is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'code-reviewer', tool_input: { to: 'researcher', message: 'hi' } }), null);
});

function runHomeDeleteGuard(tool_name?: any, command?: any) {
  return runHookOutput(GUARD_HOME_DELETE, { tool_name, tool_input: { command } });
}

function runBashWindowsPathGuard(command?: any, platform = 'win32') {
  const out = execFileSync(process.execPath, [
    '-e',
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); require(${JSON.stringify(GUARD_BASH_WINDOWS_PATHS)});`,
  ], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

function runPowerShellCmdShimGuard(command?: any, platform = 'win32') {
  const out = execFileSync(process.execPath, [
    '-e',
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); require(${JSON.stringify(GUARD_POWERSHELL_CMD_SHIMS)});`,
  ], {
    input: JSON.stringify({ tool_name: 'PowerShell', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('Bash Windows-path guard: denies an unquoted backslash path', () => {
  const token = 'C:\\Users\\kenny\\AppData\\Local\\Temp\\lookup4.err';
  const out = runBashWindowsPathGuard(`node script.js 2> ${token}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: allows a backslash path inside a heredoc body', () => {
  for (const command of [
    "cat <<'EOF'\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\nEOF\n",
    'cat <<END\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\nEND\n',
    'cat <<-END\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\n\tEND\n',
  ]) {
    assert.strictEqual(runBashWindowsPathGuard(command), null, command);
  }
});

test('Bash Windows-path guard: allows a single-quoted backslash path', () => {
  assert.strictEqual(runBashWindowsPathGuard("node script.js 'C:\\Users\\kenny\\lookup4.err'"), null);
});

test('Bash Windows-path guard: allows a double-quoted backslash path', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js "C:\\Users\\kenny\\lookup4.err"'), null);
});

test('Bash Windows-path guard: denies a double-quoted path whose backslash escapes a dollar', () => {
  const out = runBashWindowsPathGuard('node script.js "C:\\Users\\kenny\\$name\\lookup4.err"');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /double quotes eat the backslash/);
});

test('Bash Windows-path guard: allows writing a scratch script through a heredoc', () => {
  const command = [
    'cat > "C:\\Users\\kenny\\AppData\\Local\\Temp\\claude\\scratch\\probe.js" <<\'EOF\'',
    'const root = "C:\\dev\\eigenwise\\toolshed";',
    'const raw = C:\\dev\\eigenwise\\toolshed;',
    'console.log(root, raw);',
    'EOF',
  ].join('\n');
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: allows a plain-text heredoc append', () => {
  const command = 'cat >> notes.md <<\'EOF\'\n## findings\n- one\n- two\nEOF\n';
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: allows a heredoc body inside a command substitution', () => {
  const command = 'echo "$(cat <<\'EOF\'\nC:\\dev\\atomic-agents\\notes\nEOF\n)"';
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: a stray quote in a comment does not leak into a heredoc body', () => {
  for (const comment of ['# writes the "notes" file', "# don't rewrite it"]) {
    const command = `${comment}\ncat > notes.md <<'EOF'\nC:\\dev\\atomic-agents\\notes\nEOF\n`;
    assert.strictEqual(runBashWindowsPathGuard(command), null, comment);
  }
});

test('Bash Windows-path guard: denies an unquoted path on the heredoc-opening line', () => {
  const token = 'C:\\Users\\kenny\\notes.md';
  const out = runBashWindowsPathGuard(`cat > ${token} <<'EOF'\nplain body\nEOF\n`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: still denies an unquoted path after a heredoc body', () => {
  const token = 'C:\\Users\\kenny\\lookup4.err';
  const command = `cat <<EOF\nC:\\dev\\atomic-agents\nEOF\nnode script.js ${token}`;
  const out = runBashWindowsPathGuard(command);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: keeps scanning a continued heredoc header', () => {
  const token = 'C:\\Users\\kenny\\lookup4.err';
  const command = `cat <<EOF \\\nnode script.js ${token}\nC:\\dev\\atomic-agents\nEOF\n`;
  const out = runBashWindowsPathGuard(command);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: allows forward-slash paths', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js 2> C:/Users/kenny/AppData/Local/Temp/lookup4.err'), null);
});

test('Bash Windows-path guard: is a no-op outside Windows', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js 2> C:\\Users\\kenny\\AppData\\Local\\Temp\\lookup4.err', 'linux'), null);
});

test('Bash Windows-path guard: warns when Git Bash rewrites a container path', () => {
  const out = runBashWindowsPathGuard('docker exec -w /app contractify-docai uv run python -c "..."');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /MSYS_NO_PATHCONV=1 docker exec -w \/app/);
  assert.match(out.hookSpecificOutput.additionalContext, /docker exec -w \/\/app/);
});

test('Bash Windows-path guard: allows protected container path spellings', () => {
  for (const command of [
    'MSYS_NO_PATHCONV=1 docker exec -w /app contractify-docai uv run python -c "..."',
    'docker exec -w //app contractify-docai uv run python -c "..."',
  ]) {
    assert.strictEqual(runBashWindowsPathGuard(command), null, command);
  }
});

test('Bash Windows-path guard: warns for Docker volume and kubectl workdir flags', () => {
  for (const command of [
    'docker run --volume /app:/workspace image',
    'kubectl exec pod --workdir /app -- command',
  ]) {
    assert.match(runBashWindowsPathGuard(command).hookSpecificOutput.additionalContext, /Git Bash rewrites/);
  }
});

test('PowerShell cmd-shim guard: warns with both working Start-Process forms', () => {
  for (const shim of ['npm', 'npx', 'yarn', 'pnpm']) {
    const out = runPowerShellCmdShimGuard(`Start-Process -FilePath "${shim}" -ArgumentList "run","dev"`);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`-FilePath "${shim}\\.cmd"`));
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`-FilePath "cmd" -ArgumentList "\\/c","${shim}","run","dev"`));
  }
});

test('PowerShell cmd-shim guard: allows an explicit shim and non-Windows platforms', () => {
  assert.strictEqual(runPowerShellCmdShimGuard('Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev"'), null);
  assert.strictEqual(runPowerShellCmdShimGuard('Start-Process -FilePath "npm" -ArgumentList "run","dev"', 'linux'), null);
});

test('home-delete guard: blocks a recursive delete using $home', () => {
  const out = runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force $home');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /user profile or \.claude root/);
});

test('home-delete guard: applies to executors too', () => {
  const out = runHookOutput(GUARD_HOME_DELETE, {
    tool_name: 'PowerShell', agent_type: 'sidequest-exec-high', agent_id: 'executor',
    tool_input: { command: 'Remove-Item -Recurse -Force $home' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks profile and .claude roots', () => {
  for (const command of [
    'Remove-Item -Recurse -Force $env:USERPROFILE',
    'rm -rf %USERPROFILE%',
    `rm -rf ${path.join(os.homedir(), '.claude')}`,
  ]) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('home-delete guard: blocks a recursive delete of the profile root', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${os.homedir()}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks a parent traversal from .claude', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${path.join(os.homedir(), '.claude', '..')}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: allows forced non-recursive and continued scoped deletes', () => {
  for (const command of [
    'rm -f C:/Users/x/AppData/Local/Temp/observability/file',
    `rm -f "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
    `rm -rf "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
  ]) {
    assert.strictEqual(runHomeDeleteGuard('Bash', command), null, command);
  }
});

test('home-delete guard: a lone forward slash is still the drive root', () => {
  const commands = ['rm -rf /', 'rm -rf C:\\scratchpad\\observability /'];
  if (process.platform === 'win32') commands.push('rm -rf D:/');
  for (const command of commands) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('home-delete guard: allows scratchpad deletion', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force C:\\scratchpad\\run-42'), null);
});

test('home-delete guard: allows non-delete PowerShell commands', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Get-ChildItem $HOME'), null);
});

test('home-delete guard: allows observed non-destructive scratchpad commands', () => {
  const scratchpad = path.join(os.tmpdir(), 'claude', 'sq-1330');
  for (const command of [
    `grep -n "profile" ${path.join(scratchpad, 'verify.log')}`,
    `cat <<'EOF' > ${path.join(scratchpad, 'script.js')}\nconsole.log('scratchpad');\nEOF`,
    `rm -f ${path.join(scratchpad, 'script.js')}`,
    `rm -rf ${path.join(scratchpad, 'cache')}; grep -n "$home" ${path.join(scratchpad, 'verify.log')}`,
  ]) {
    assert.strictEqual(runHomeDeleteGuard('Bash', command), null, command);
  }
});

test('worktree isolation guard: allows unparseable read and verify-wrapper Bash commands', () => {
  const filteredVerifyCommand = 'log="$(mktemp "${TMPDIR:-/tmp}/sidequest-verify.XXXXXX.log")"\n(cd plugins/sidequest && npm run test:full) > "$log" 2>&1\nstatus=$?\ngrep -nE "^not ok|^# (fail|pass)" "$log" | head -40';
  for (const command of [
    'grep -n "guard" plugins/sidequest/test/hooks.test.ts',
    filteredVerifyCommand,
  ]) {
    assert.strictEqual(runHookOutput(GUARD_WORKTREE_ISOLATION, {
      tool_name: 'Bash',
      agent_type: 'sidequest-exec-dispatch',
      agent_id: 'sq-1330-fixture',
      tool_input: { command },
    }), null, command);
  }
});

test('home-delete guard: blocks the 2026-07-16 incident command verbatim', () => {
  const out = runHomeDeleteGuard('PowerShell', '$home = Join-Path "C:\\Temp\\x" "sq330-runtime"; if (Test-Path $home) { Remove-Item -Recurse -Force $home -Confirm:$false }');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks deletes wrapped in blocks, pipelines, and aliases', () => {
  for (const command of [
    'Get-ChildItem ~ | ForEach-Object { Remove-Item -Recurse -Force $home }',
    'if (Test-Path $home) { ri -Recurse -Force $home }',
    'rd /s %USERPROFILE%',
  ]) {
    assert.equal(runHomeDeleteGuard('PowerShell', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('session-start sweep is fail-soft and releases only claims past the TTL', () => {
  const stale = addTicket('session-start stale claim');
  const fresh = addTicket('session-start fresh claim');
  store.updateTicket(slug, stale.ref, { labels: ['direct-ok'] });
  store.updateTicket(slug, fresh.ref, { labels: ['direct-ok'] });
  const reason = 'The stale-claim fixture needs local direct claims.';
  assert.equal(store.claimTicket(slug, stale.ref, 'stale-session', { direct: true, reason }).ok, true);
  assert.equal(store.claimTicket(slug, fresh.ref, 'fresh-session', { direct: true, reason }).ok, true);
  const staleTicket = store.getTicket(slug, stale.ref);
  staleTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  db.putRow(database, 'tickets', {
    id: staleTicket.id, project: slug, ref: staleTicket.ref, status: staleTicket.status,
    archived: staleTicket.archived ? 1 : 0, ord: staleTicket.order, claim_by: staleTicket.claim.by, data: staleTicket,
  });
  assert.doesNotThrow(() => runHook(SESSION, { session_id: 'sweep-test' }));
  assert.equal(store.getTicket(slug, stale.ref).claim, null);
  assert.equal(store.getTicket(slug, fresh.ref).claim.by, 'fresh-session');
});

test('session-end sweeps old patch-equivalent worktrees and stays fail-soft', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-project-'));
  const worktrees = path.join(project, '.claude', 'worktrees');
  const projectGit = (args: string[], cwd?: string) => execFileSync('git', args, { cwd: cwd || project, encoding: 'utf8', windowsHide: true }).trim();
  projectGit(['init']);
  projectGit(['config', 'user.name', 'Sidequest Test']);
  projectGit(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), 'session-end fixture\n');
  projectGit(['add', '.']);
  projectGit(['commit', '-m', 'base']);
  projectGit(['branch', '-M', 'main']);
  fs.mkdirSync(worktrees, { recursive: true });
  const worktree = path.join(worktrees, 'agent-session-end');
  const branch = 'worktree-agent-session-end';
  projectGit(['worktree', 'add', '-b', branch, worktree, 'main']);
  fs.writeFileSync(path.join(worktree, 'integrated.txt'), 'integrated\n');
  projectGit(['add', 'integrated.txt'], worktree);
  projectGit(['commit', '-m', 'integrated fixture'], worktree);
  const commit = projectGit(['rev-parse', 'HEAD'], worktree);
  projectGit(['cherry-pick', commit]);
  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, old, old);
  store.ensureProject(project);

  assert.doesNotThrow(() => runHook(SESSION_END, { session_id: 'session-end-test', cwd: project }));
  assert.ok(!fs.existsSync(worktree));
  assert.equal(projectGit(['branch', '--list', branch]), '');
  assert.doesNotThrow(() => runHook(SESSION_END, { session_id: 'session-end-fail-soft' }, { CLAUDE_PLUGIN_ROOT: path.join(project, 'missing-plugin') }));
});

test('stop reminder: tells a claimed executor to hold pending scope approval', () => {
  const sessionId = `reconcile-scope-${++sqSeq}`;
  const ticket = addStopTicket('scope approval pending', { files: ['declared/'] });
  claimStopTicket(ticket, sessionId, 'reconcile-scope');
  const request = store.requestScope(slug, ticket.ref, 'reconcile-scope', ['outside/new.ts']);
  assert.deepEqual(request.scopeRequest.files, ['outside/new.ts']);

  const output = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  const reminder = output.hookSpecificOutput.additionalContext;
  assert.match(reminder, /1 ticket waiting on scope approval from the orchestrator/);
  assert.match(reminder, /Checkpoint and hold; never release, releasing loses work/);
  assert.doesNotMatch(reminder, /Update or close/);
  assert.ok(Buffer.byteLength(reminder) <= BUDGET.reconciliation, `reconciliation reminder is ${Buffer.byteLength(reminder)} bytes`);
});

// Session ids diverge across a long orchestration, and the old exemption was
// keyed on them, so a healthy running wave read as unfinished business and the
// orchestrator was told to go close tickets its executors were mid-way through
// (the-bot-resurrection, three times in one night).
test('stop reminder: a live executor claim is in progress, not unfinished business', () => {
  const dispatchSession = `reconcile-live-dispatch-${++sqSeq}`;
  const ticket = addStopTicket('live executor mid-run');
  claimStopTicket(ticket, dispatchSession, 'reconcile-live-executor');

  const laterSession = `reconcile-live-later-${++sqSeq}`;
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: dispatchSession, cwd: BOARD_PATH }), null,
    'the session that dispatched it sees a running wave, not an open ticket');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: laterSession, cwd: BOARD_PATH }), null,
    'a session id that moved on does not resurrect the reminder');

  // Once the dispatch goes terminal the claim is nobody's live work, and the
  // ticket is business the orchestrator still owes an answer on.
  assert.equal(store.releaseTicket(slug, ticket.ref, 'reconcile-live-executor', { status: 'doing', source: 'test' }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'reconcile-live-orchestrator', {
    direct: true, reason: 'A direct claim with no live dispatch stays this session\'s own to close.',
  }).ok, true);
  const reminded = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: dispatchSession, cwd: BOARD_PATH });
  assert.match(reminded.hookSpecificOutput.additionalContext, /1 ticket in doing/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'reconcile-live-orchestrator', { status: 'todo', source: 'test' }).ok, true);
});

test('stop reminder: names and re-escalates pending submissions within its byte budget', () => {
  const sessionId = `reconcile-${++sqSeq}`;
  const submitted = addTicket('pending integration');
  claimStopTicket(submitted, sessionId, 'reconcile-submitted');
  assert.equal(store.getTicket(slug, submitted.ref).dispatch.sessionId, sessionId);
  assert.equal(store.findProject(BOARD_PATH).slug, slug);
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-submitted', {
    commit: 'abc1234',
    sessionId,
  }).ok, true);

  const input = { session_id: sessionId, cwd: BOARD_PATH };
  const initial = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input);
  assert.equal(initial.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(initial.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.match(initial.hookSpecificOutput.additionalContext, /Checkpoint and hold; never release, releasing loses work/);
  assert.doesNotMatch(initial.hookSpecificOutput.additionalContext, /Update or close/);
  assert.equal(initial.systemMessage, undefined, 'the reminder must go to Claude rather than the user-visible system message');
  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input), null, 'a pending submission waits before escalating');

  const escalated = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input);
  const reminder = escalated.hookSpecificOutput.additionalContext;
  assert.match(reminder, new RegExp(submitted.ref));
  assert.match(reminder, /3 consecutive stops/);
  assert.match(reminder, /Checkpoint and hold; never release, releasing loses work/);
  assert.ok(Buffer.byteLength(reminder) <= BUDGET.reconciliation, `reconciliation reminder is ${Buffer.byteLength(reminder)} bytes`);

  const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  const sizeAfterEscalation = fs.statSync(stateFile).size;
  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input), null, 'the escalation does not repeat on every stop');
  assert.equal(fs.statSync(stateFile).size, sizeAfterEscalation, 'the reminder state stays bounded across stops');
});

test('stop reminder: resets its counter when the board signature changes', () => {
  const sessionId = `reconcile-reset-${++sqSeq}`;
  const submitted = addTicket('reset reconciliation reminder');
  claimStopTicket(submitted, sessionId, 'reconcile-reset');
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-reset', {
    commit: 'def1234',
    sessionId,
  }).ok, true);

  const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ state: 'stale-signature', count: 3 }));

  const output = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  assert.match(output.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /consecutive stops/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).count, 1);
});

test('stop reminder: ignores this session\'s live dispatched tickets in doing or todo', () => {
  const sessionId = `reconcile-live-${++sqSeq}`;
  const doing = addTicket('executor is verifying');
  const todo = addTicket('executor has not claimed yet');
  claimStopTicket(doing, sessionId, 'reconcile-live-doing');
  store.prepareDispatch(slug, todo.ref, { sessionId });

  assert.equal(store.getTicket(slug, doing.ref).status, 'doing');
  assert.equal(store.getTicket(slug, todo.ref).status, 'todo');
  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH }), null);
});

test('stop reminder: counts terminal dispatched claims that are reclaimable', () => {
  const sessionId = `reconcile-terminal-${++sqSeq}`;
  const ticket = addTicket('dead executor');
  const stop = claimStopTicket(ticket, sessionId, 'reconcile-terminal');
  assert.equal(recordTerminalAgentFailure(ticket, stop).ok, true);
  assert.equal(store.claimPulse(store.getTicket(slug, ticket.ref)).reclaimable, 'observed_stop');

  const output = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  assert.match(output.hookSpecificOutput.additionalContext, /1 ticket in doing/);
});

test('stop reminder: excludes live claims from a mixed live and terminal dispatched wave', () => {
  const sessionId = `reconcile-mixed-${++sqSeq}`;
  const live = addTicket('live executor');
  const dead = addTicket('dead executor');
  claimStopTicket(live, sessionId, 'reconcile-mixed-live');
  const stop = claimStopTicket(dead, sessionId, 'reconcile-mixed-dead');
  assert.equal(recordTerminalAgentFailure(dead, stop).ok, true);

  const output = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  assert.match(output.hookSpecificOutput.additionalContext, /1 ticket in doing/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /2 tickets in doing/);
});test('stop reminder: stays silent for a quiet session and when nudges are off', () => {
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    session_id: `reconcile-quiet-${++sqSeq}`,
    cwd: BOARD_PATH,
  }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }), null);

  const sessionId = `reconcile-off-${++sqSeq}`;
  const ticket = addTicket('nudge disabled');
  claimStopTicket(ticket, sessionId, 'reconcile-off');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    session_id: sessionId,
    cwd: BOARD_PATH,
  }, { SIDEQUEST_NUDGE: 'off' }), null);
});

test('stop reminder: ignores re-entry and only re-escalates pending submissions', () => {
  const sessionId = `reconcile-bound-${++sqSeq}`;
  const ticket = addTicket('bounded reconciliation reminder');
  const stop = claimStopTicket(ticket, sessionId, 'reconcile-bound');
  assert.equal(recordTerminalAgentFailure(ticket, stop).ok, true);
  const input = { session_id: sessionId, cwd: BOARD_PATH };

  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    ...input,
    stop_hook_active: true,
  }), null, 're-entered Stop hooks must never emit another continuation');
  assert.ok(runHookOutput(BOARD_RECONCILIATION_REMINDER, input)?.hookSpecificOutput?.additionalContext);
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null, 'a stable board without a submission must not re-fire');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null, 'a stable board without a submission remains silent');
});

test('session-start excludes the retired generic-agent bypass', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  const pluginRoot = path.join(__dirname, '..');
  const forceBypass = fs.readFileSync(path.join(HOOKS, 'force-exec-bypass.js'), 'utf8');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
  for (const surface of [forceBypass, skill, ctx]) {
    assert.doesNotMatch(surface, new RegExp(RETIRED_SCOUT), 'published guidance must not carry the retired bypass');
  }
});

test('session-start adds model-specific checkpoint guidance only for eligible models', () => {
  const defaultContext = runHook(SESSION, { session_id: 'checkpoint-none' });
  const sonnet = runHook(SESSION, { session_id: 'checkpoint-sonnet', model: 'claude-sonnet-5' });
  assert.notEqual(sonnet, defaultContext);
  const compactDefault = runHook(SESSION, { session_id: 'checkpoint-compact-none', source: 'compact' });
  const compact = runHook(SESSION, { session_id: 'checkpoint-compact', source: 'compact', model: 'claude-haiku-4-5' });
  assert.notEqual(compact, compactDefault);

  for (const payload of [
    { session_id: 'checkpoint-none' },
    { session_id: 'checkpoint-opus', model: 'claude-opus-5' },
  ]) {
    assert.doesNotMatch(runHook(SESSION, payload), /CHECKPOINT MODE/, 'an absent or higher-tier model must not silently enable checkpoint mode');
  }
});

test('session-start: shows the live investigation workforce within its cap', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-workforce-'));
  for (const source of ['', 'compact', 'resume']) {
    const ctx = runHookForBudget(SESSION, { session_id: `workforce-${source || 'startup'}`, source }, {
      SIDEQUEST_HOME: home,
      CLAUDE_PROJECT_DIR: path.join(home, 'project'),
    });
    const start = ctx.indexOf('YOUR EXECUTORS — delegate work AND investigation to them:');
    assert.ok(start >= 0, `${source || 'startup'} includes the workforce`);
    const workforce = ctx.slice(start);
    assert.ok(Buffer.byteLength(workforce) <= BUDGET.workforce, `${source || 'startup'} workforce is ${Buffer.byteLength(workforce)} bytes`);
    for (const id of ['codebase-exploration', 'debugging', 'spike-investigation', 'source-lookup', 'evidence-research']) {
      assert.match(workforce, new RegExp(`${id} — .+ \\(.+·.+\\)`), id);
    }
    assert.match(workforce, /visual-evaluation — (?:.+ )?\(.+·.+\)/, 'visual-evaluation');
  }
});

test('session-start: bounds oversized workforces and reports omitted categories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-workforce-cap-'));
  for (let index = 0; index < 80; index += 1) {
    writeCategory(home, {
      id: `oversized-category-${String(index).padStart(2, '0')}`,
      name: `Oversized category ${index}`,
      route: { model: 'sonnet', effort: 'medium' },
      enabled: true,
    });
  }
  const output = JSON.parse(runSessionWithHomeForBudget(home, { CLAUDE_PROJECT_DIR: path.join(home, 'project') }));
  const workforce = output.hookSpecificOutput.additionalContext.slice(output.hookSpecificOutput.additionalContext.indexOf('YOUR EXECUTORS — delegate work AND investigation to them:'));
  assert.ok(Buffer.byteLength(workforce) <= BUDGET.workforce, `oversized workforce is ${Buffer.byteLength(workforce)} bytes`);
  assert.match(workforce, /… \d+ more enabled categories\./);
});

test('session-start: stays inside its byte budget and off the retired doctrine', () => {
  const ctx = runHookForBudget(SESSION, { session_id: 'test' });
  assert.ok(
    ctx.length <= BUDGET.session,
    `session block is ${ctx.length} chars — budget is ${BUDGET.session}; trim it, don't raise the budget`
  );
  assertNoRetiredDoctrine(ctx, 'session-start');
});

test('session-start: reports newly provisioned executors once, then stays quiet', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-agents-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const first = JSON.parse(runSessionWithHome(home));
  const firstContext = first.hookSpecificOutput.additionalContext;
  assert.match(firstContext, /Reload plugins before spawning newly created temporary native agents/);

  const second = JSON.parse(runSessionWithHome(home));
  const secondContext = second.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(secondContext, /Executor definitions were just \(re\)provisioned/);
});
test('session-start: provisions the shared dispatch executor and prunes legacy per-combo defs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-codex-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const legacyFile = path.join(agents, 'sidequest-exec-codex-gpt-5-6-terra-high.md');
  fs.writeFileSync(legacyFile, '<!-- generated-by: sidequest-agentsync -->\nold');
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'model-gateway', models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });
  assert.ok(!fs.existsSync(legacyFile), 'legacy per-combo Codex executor must be pruned by session sync');
  assert.ok(fs.existsSync(path.join(agents, 'sidequest-exec-dispatch.md')), 'reachable Codex route must provision the shared dispatch executor');
});

test('session-start: category-route sync ignores retired prefs data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-unreadable-'));
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const codexFile = path.join(agents, 'sidequest-exec-dispatch.md');
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  db.openDb(home).prepare("INSERT INTO globals (key, data) VALUES ('model-prefs', '{')").run();
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'model-gateway', models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });
  assert.ok(fs.existsSync(codexFile), 'a category route must provision despite unreadable retired prefs data');
});
test('session-start sweeps an old removable worktree to completion', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-sweep-'));
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const old = path.join(worktrees, 'agent-session-sweep');
  gitFixture(['init'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  fs.mkdirSync(worktrees, { recursive: true });
  gitFixture(['worktree', 'add', '-b', 'worktree-agent-session-sweep', old, 'main'], repo);
  fs.writeFileSync(path.join(old, 'sweep.txt'), 'integrated\n');
  gitFixture(['add', 'sweep.txt'], old);
  gitFixture(['commit', '-m', 'integrated fixture'], old);
  const commit = gitFixture(['rev-parse', 'HEAD'], old);
  gitFixture(['cherry-pick', commit], repo);
  const aged = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(old, aged, aged);
  store.ensureProject(repo);

  runHook(SESSION, { session_id: 'session-sweep', source: 'startup', cwd: repo }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });
  assert.ok(!fs.existsSync(old), 'SessionStart awaits the sweep until the worktree is gone');
});

// The sweep's cost is bimodal, so the hook hands it to a detached worker and waits
// only up to a deadline. These pin the deadline path: a slow sweep must cost the
// session its notices, never its whole injected context.
function sweepReportFile(home: string, cwd: string): string {
  const key = require('node:crypto').createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(home, 'sweep-reports', `${key}.json`);
}

test('session-start: a sweep past its deadline still injects the full block and says so', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-deadline-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-deadline-cwd-'));
  const context = runHook(
    SESSION,
    { session_id: 'sweep-deadline', source: 'startup', cwd },
    { SIDEQUEST_HOME: home, SIDEQUEST_SWEEP_DEADLINE_MS: '0', CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }
  );
  assert.match(context, /worktree sweep exceeded its SessionStart budget/);
  assert.match(context, /arrives on the next session start/);
  assert.ok(context.includes('=== sidequest (active) ==='), 'a deferred sweep must not cost the session its orchestrator block');
  assert.ok(context.includes('YOUR EXECUTORS'), 'a deferred sweep must not cost the session its workforce');
});

test('session-start: a deferred sweep report is drained into the next session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-drain-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-drain-cwd-'));
  const report = sweepReportFile(home, cwd);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify({ notices: ['sidequest: carried sweep notice from last session'] }));

  const context = runHook(
    SESSION,
    { session_id: 'sweep-drain', source: 'startup', cwd },
    { SIDEQUEST_HOME: home, SIDEQUEST_SWEEP_DEADLINE_MS: '0', CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }
  );
  assert.match(context, /carried sweep notice from last session/);
  assert.ok(!fs.existsSync(report), 'a drained report must be cleared so it is not replayed forever');
});

test('sweep worker: records its notices for the next session instead of dropping them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-worker-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-worker-'));
  gitFixture(['init'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  const boardHome = db.openDb(home);
  assert.ok(boardHome, 'fixture home must open');
  execFileSync(process.execPath, [path.join(HOOKS, 'sweep-worktrees.js'), '--cwd', repo, '--session', 'worker'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
  });
  const report = sweepReportFile(home, repo);
  assert.ok(fs.existsSync(report), 'the worker must always leave a report, so a crashed sweep is distinguishable from a quiet one');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(report, 'utf8')).notices));
});

test('session-start skips an unavailable integration target without failing the sweep', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-sweep-target-'));
  gitFixture(['init'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  const board = store.ensureProject(repo);
  store.setBoardConfig(board.slug, { integrationBranch: 'missing-target' });

  const context = runHook(SESSION, { session_id: 'session-target', source: 'startup', cwd: repo }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });
  assert.match(context, /skipped worktree sweep/);
  assert.match(context, /configured integration branch is unavailable locally/);
  assert.doesNotMatch(context, /worktree sweep failed/);
});

test('session-start compact contexts retain executable safeguards', () => {
  for (const source of ['compact', 'resume']) {
    const ctx = runHookForBudget(SESSION, { session_id: 't', source });
    assert.match(ctx, /never\s+TaskOutput/i, `${source} must ban native Agent TaskOutput polling`);
    assert.ok(/list --status(?: |=)doing/.test(ctx), `${source} must retain the CLI fallback`);
    assert.ok(!ctx.includes('external tracker'), `${source} must not inject the full block`);
    assert.ok(Buffer.byteLength(ctx) <= BUDGET.compact, `${source} block is ${Buffer.byteLength(ctx)} bytes — budget is ${BUDGET.compact}`);
  }
});

test('session-start: embeds the expanded plugin path in CLI fallbacks', () => {
  const pluginRoot = FIXED_PLUGIN_ROOT;
  const ctx = runHookForBudget(
    SESSION,
    { session_id: 't', source: 'compact' }
  );
  assert.ok(ctx.includes(`node "${pluginRoot}/bin/sidequest.js"`), 'CLI fallback must embed the hook runtime plugin path');
  assert.ok(!ctx.includes('${CLAUDE_PLUGIN_ROOT}'), 'CLI fallback must not rely on an unset shell variable');
  assert.ok(Buffer.byteLength(ctx) <= BUDGET.compact, `compact block is ${Buffer.byteLength(ctx)} bytes — budget is ${BUDGET.compact}`);
});

test('session-start: SIDEQUEST_NUDGE=off silences it', () => {
  const out = execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_NUDGE: 'off' },
  });
  assert.strictEqual(out.trim(), '', 'should emit nothing when nudge is off');
});

test('subagent-start warns only for embedded worktrees outside the receiving agent checkout', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diagnostic-worktrees-'));
  gitFixture(['init'], repo);
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const current = path.join(worktrees, 'agent-current');
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'agent-current')}\n`);
  const payload = {
    session_id: 'diagnostic-worktree-warning',
    agent_type: 'sidequest-exec-dispatch',
    agent_id: 'diagnostic-worktree-agent',
    cwd: current,
  };

  assert.equal(runHook(SUBAGENT_START, payload), '', 'the receiving agent\'s own worktree must stay quiet');
  fs.mkdirSync(path.join(worktrees, 'agent-foreign'));
  const warning = runHook(SUBAGENT_START, payload);
  assert.match(warning, /foreign agent worktrees detected/);
  assert.match(warning, /error-severity diagnostics/);
});

test('ticket filing stays explicit while the Agent gate enforces dispatch and docs match it', () => {
  const pluginRoot = path.join(__dirname, '..');
  const repoRoot = path.join(pluginRoot, '..', '..');
  const references = [
    path.join(repoRoot, 'README.md'),
    path.join(pluginRoot, 'README.md'),
    path.join(pluginRoot, 'bin', 'sidequest.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
  ];

  assert.ok(!fs.existsSync(path.join(pluginRoot, 'agents', 'ticket-filer.md')));
  assert.ok(!fs.existsSync(path.join(HOOKS, 'capture-nudge.js')));
  for (const file of references) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('ticket-filer'), `${file} must not reference ticket-filer`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.ok(config.hooks.UserPromptSubmit.some((entry?: any) => entry.hooks
    .some((hook?: any) => hook.command.includes('board-first-reminder.js'))), 'the board-first reminder must run for user prompts');
  assert.ok(config.hooks.Stop.some((entry?: any) => entry.hooks
    .some((hook?: any) => hook.command.includes('board-reconciliation-reminder.js'))), 'the reconciliation reminder must run before a session stops');
  assert.doesNotMatch(JSON.stringify(config), /capture-nudge|ticket-filer/);
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === '*'
    && entry.hooks.some((hook?: any) => hook.command.includes('inline-work-nudge.js'))), 'the inline-work reminder must be registered for every tool');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Agent'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the Agent gate must be registered');
  assert.ok(!config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Skill'), 'the oversized Skill guard stays removed: its one activation cost a turn and prevented nothing');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Edit|Write|MultiEdit|NotebookEdit'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the helper write guard must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'TaskOutput'
    && entry.hooks.some((hook?: any) => hook.command.includes('guard-task-output.js'))), 'the TaskOutput guard must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Bash|PowerShell'
    && entry.hooks.some((hook?: any) => hook.command.includes('repeated-command-warn.js'))), 'the repeated-command warning must run for shell commands');
  assert.ok(config.hooks.TeammateIdle.some((entry?: any) => entry.hooks
    .some((hook?: any) => hook.command.includes('teammate-idle.js'))), 'terminal teammates must stop when idle');

  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /per-prompt "use sidequest" reminder/);
  assert.doesNotMatch(readme, /marker-triggered capture/);
  assert.doesNotMatch(readme, /native_agent/);
  for (const file of [
    path.join(pluginRoot, 'README.md'),
    path.join(HOOKS, 'force-exec-bypass.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
    path.join(pluginRoot, 'skills', 'sidequest', 'references', 'orchestration.md'),
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(RETIRED_SCOUT), `${file} must not carry the retired bypass`);
  }
});

/* ------------------------------------------------------------------ *
 *  SubagentStop — flag a runaway (likely non-atomic) executor run post-hoc.
 *
 *  The hook can't stop a running subagent; it turns a long claim into ONE visible
 *  line so the orchestrator notices the ticket wasn't atomic. Elapsed comes from
 *  the claim's OWN start `at` in the worker registry (store already records it),
 *  NOT from the SubagentStop stdin — which we pass BARE here to prove that. We
 *  simulate a 28-min run by backdating the registry claim, then run the hook.
 * ------------------------------------------------------------------ */

let sqSeq = 0;
function addTicket(title?: any) {
  return addStopTicket(title);
}

function addStopTicket(title?: any, fields?: any) {
  const category = `hooks-stop-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, Object.assign({
    title,
    category,
    source: 'cli',
  }, fields));
}

function addEffortTicket(title?: any, effort?: any) {
  const category = `hooks-effort-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, {
    title,
    category,
    source: 'cli',
  });
}

function claimStopTicket(ticket?: any, sessionId?: any, by?: any) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const agentId = `stop-agent-${ticket.id}-${++sqSeq}`;
  const agentName = `stop-executor-${ticket.id}-${sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { session_id: sessionId, agent_type: prepared.ticket.dispatchExecutor, agent_id: agentId, agent_name: agentName };
}

function recordTerminalAgentFailure(ticket?: any, stop?: any) {
  const current = store.getTicket(slug, ticket.ref);
  return store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: current.dispatchNonce,
    executor: stop.agent_type,
    error: 'Prompt is too long',
  });
}

// Backdate the claim's `at` without waiting real time.
function backdateSessionClaims(sessionId?: any, minutesAgo?: any, effort?: any) {
  const w = db.getRow(database, 'globals', 'workers');
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (const c of w.sessions[sessionId].claims) {
    c.at = at;
    if (effort) c.effort = effort;
  }
  w.sessions[sessionId].updatedAt = at;
  db.putRow(database, 'globals', { key: 'workers', data: w });
}

test('subagent-stop: a terminal Agent failure reports durable death evidence within budget', () => {
  const sess = `sess-long-${++sqSeq}`;
  const t = addTicket('runaway 28-min ticket');
  const stop = claimStopTicket(t, sess, 'worker-long');
  backdateSessionClaims(sess, 28);
  assert.equal(recordTerminalAgentFailure(t, stop).ok, true);
  const ctx = runHookForBudget(SUBAGENT_STOP, stop);
  const expectedWorktree = path.join(BOARD_PATH, '.claude', 'worktrees', `agent-${stop.agent_id}`);
  assert.match(ctx, new RegExp(`^exec DIED: ${t.ref} at `));
  assert.match(ctx, /board quiet since .*; checkpoint none; commit none; comment none/);
  assert.ok(ctx.includes(`worktree ${expectedWorktree}`));
  assert.match(ctx, /Next: recover the worktree diff, or release \+ fresh dispatch\.$/);
  assert.equal(store.getTicket(slug, t.ref).dispatch.outcome, 'died');
  assert.ok(store.getTicket(slug, t.ref).dispatch.terminalAt);
  assert.ok(ctx.length <= BUDGET.longrun, `stop verdict is ${ctx.length} chars — budget is ${BUDGET.longrun}`);
  assert.ok(ctx.indexOf('\n') === -1, 'the verdict must stay ONE line');
});

test('subagent-stop: a held claim is classified regardless of claimed effort', () => {
  const tiers = ['low', 'medium', 'high', 'xhigh'];

  for (const effort of tiers) {
    const session = `sess-${effort}-${++sqSeq}`;
    const ticket = addEffortTicket(`${effort} stopped claim`, effort);
    const stop = claimStopTicket(ticket, session, `worker-${effort}`);
    const ctx = runHook(SUBAGENT_STOP, stop);
    assert.match(ctx, new RegExp(`^exec WAITING: ${ticket.ref} ended a turn while holding its claim; it may resume\.`));
  }
});

test('subagent-stop: stop_hook_active suppresses the note (no self-continuation loop)', () => {
  const sess = `sess-active-${++sqSeq}`;
  const t = addTicket('over-threshold ticket, but re-entrant fire');
  store.updateTicket(slug, t.ref, { labels: ['direct-ok'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-active', { direct: true, reason: 'The re-entrant hook fixture needs a direct claim.', sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, stop_hook_active: true }),
    '',
    'a fire carrying stop_hook_active is our own continuation and must never re-emit'
  );
});

test('subagent-stop: a non-executor child (reviewer) is not nagged about a session claim', () => {
  const sess = `sess-reviewer-${++sqSeq}`;
  const t = addTicket('over-threshold executor claim, unrelated reviewer stops');
  const stop = claimStopTicket(t, sess, 'worker-rev');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'code-reviewer' }),
    '',
    'a reviewer shares the session id but never held the claim — it must stay silent'
  );
  // The same over-threshold claim still surfaces for the actual executor child.
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.ok(ctx.includes(t.ref), 'a sidequest executor child must still get the note');
});

test('subagent-stop: a repeated stop repeats the held-claim verdict until release', () => {
  const sess = `sess-dedupe-${++sqSeq}`;
  const t = addTicket('over-threshold claim reports every stop');
  const stop = claimStopTicket(t, sess, 'worker-dedupe');
  backdateSessionClaims(sess, 28);
  const expected = runHook(SUBAGENT_STOP, stop);
  assert.match(expected, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), expected);
});

test('subagent-stop: a stopped executor holding a fresh claim remains resumable', () => {
  const sess = `sess-fresh-${++sqSeq}`;
  const t = addTicket('quick ticket, just claimed');
  const stop = claimStopTicket(t, sess, 'worker-fresh');
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.match(ctx, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
});

test('subagent-stop: a terminal release tells the parent to stop a Monitor-backed executor', () => {
  const sess = `sess-released-${++sqSeq}`;
  const t = addStopTicket('released ticket with a monitor still armed');
  const stop = claimStopTicket(t, sess, 'worker-released');
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-released', { status: 'todo' }).ok, true);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, stop),
    `exec FINISHED after terminal release: ${t.ref}; TaskStop this executor so an owned Monitor cannot resume it`
  );
});

test('subagent-stop: a completed executor reports a clean stop from its done comment', () => {
  const sess = `sess-completed-${++sqSeq}`;
  const t = addStopTicket('completed ticket with commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-completed');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-completed', kind: 'comment', body: 'Shipped abc1234.', source: 'cli' }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-completed', { status: 'todo' }).ok, true);
  assert.strictEqual(store.closeTicketForGrooming(slug, t.ref, { by: 'hook-test-groomer', reason: 'Shipped abc1234.' }).ok, true);
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), `exec FINISHED: ${t.ref} done (abc1234); verify, then TaskStop this executor so it doesn't linger idle`);
});

test('subagent-stop: a completed file ticket without a hash is flagged', () => {
  const sess = `sess-no-hash-${++sqSeq}`;
  const t = addStopTicket('completed ticket without commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-no-hash');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-no-hash', kind: 'comment', body: 'Done and verified.', source: 'cli' }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-no-hash', { status: 'todo' }).ok, true);
  assert.strictEqual(store.closeTicketForGrooming(slug, t.ref, { by: 'hook-test-groomer', reason: 'Done and verified.' }).ok, true);
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), `exec FINISHED: ${t.ref} done WITHOUT commit hash; verify, then TaskStop this executor so it doesn't linger idle`);
});

test('subagent-stop: a legacy partial submission is not reported ready for integration', () => {
  const sess = `sess-partial-${++sqSeq}`;
  const t = addStopTicket('partial submission awaiting scope', { files: ['docs/'] });
  const stop = claimStopTicket(t, sess, 'worker-partial');
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-partial', { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
  const partial = store.getTicket(slug, t.ref);
  partial.submission.unscopedPaths = ['plugins/model-gateway/bin/model-gateway.js'];
  db.putRow(database, 'tickets', {
    id: partial.id, project: slug, ref: partial.ref, status: partial.status,
    archived: partial.archived ? 1 : 0, ord: partial.order, claim_by: null, data: partial,
  });
  assert.strictEqual(
    runHook(SUBAGENT_STOP, stop),
    `exec FINISHED with PARTIAL_SUBMISSION: ${t.ref} has scope-gated paths (plugins/model-gateway/bin/model-gateway.js); do not integrate it`
  );
});

test('subagent-stop: a submitted executor reports READY_FOR_INTEGRATION, not a dead claim', () => {
  const sess = `sess-submitted-${++sqSeq}`;
  const t = addStopTicket('submitted ticket awaiting the publish transaction', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-submitted');
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-submitted', { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, stop),
    `exec FINISHED: ${t.ref} READY_FOR_INTEGRATION (abc1234def56); run the publish transaction (references/publishing.md), then TaskStop this executor`
  );
});

test('subagent-stop: a prior owner is silent after another worker reclaims the ticket', () => {
  const sess = `sess-prior-owner-${++sqSeq}`;
  const t = addTicket('reclaimed ticket with stale prior owner entry');
  const stop = claimStopTicket(t, sess, 'worker-prior');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-prior', {}).ok, true);
  store.updateTicket(slug, t.ref, { labels: ['direct-ok'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-current', { direct: true, reason: 'The prior-owner fixture needs a direct reclaim.', sessionId: `sess-current-${sqSeq}` }).ok, true);

  assert.strictEqual(runHook(SUBAGENT_STOP, stop), '', 'a prior owner must not be warned about another worker\'s live claim');
});
test('subagent-stop: an unidentifiable executor stays silent', () => {
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: 'sess-nobody-here', agent_type: 'sidequest-exec-high' }), '');
  assert.strictEqual(runHook(SUBAGENT_STOP, {}), '', 'a bare payload with no session id stays silent');
});

test('subagent-stop: long-run threshold settings do not suppress a held-claim verdict', () => {
  const sess = `sess-tuned-${++sqSeq}`;
  const t = addEffortTicket('5-min high-effort stopped claim', 'high');
  const stop = claimStopTicket(t, sess, 'worker-tuned');
  backdateSessionClaims(sess, 5);

  const out = execFileSync(process.execPath, [SUBAGENT_STOP], {
    input: JSON.stringify(stop),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_LONG_RUN_MIN: '2' },
  });
  const parsed = out.trim() ? JSON.parse(out) : null;
  const ctx = parsed ? parsed.hookSpecificOutput.additionalContext : '';
  assert.match(ctx, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
});

// Registered LAST: creates extra fixture categories, which would otherwise grow
// the taxonomy line inside earlier byte-budget assertions.
test('pre-tool hook: dispatch executor rejects conflicting route markers and ignores prose sibling refs', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-dispatch-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [
      { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' },
      { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]' },
    ],
  }));
  const a = fixtureTicket('SQ-347 dispatch batch A', 'codex-gpt-5-6-terra', 'high');
  const b = fixtureTicket('SQ-347 dispatch batch B', 'codex-gpt-5-6-sol', 'high');
  const proseSibling = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-prose', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nPrior ${b.ref} had a sol route. --project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.ok(!proseSibling.hookSpecificOutput.permissionDecision, 'a prose sibling ref must not create a mixed batch');
  assert.equal(proseSibling.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  const mixed = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-mixed', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: ${b.ref}\n[sidequest-route model=codex-gpt-5-6-sol effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.equal(mixed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /route marker/);
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /mixes tickets stamped with different models/);
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /Split the batch/);
  assert.doesNotMatch(mixed.hookSpecificOutput.permissionDecisionReason, /fresh dispatch briefing/);
  const same = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-same', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: SQ-999\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.ok(!same.hookSpecificOutput.permissionDecision, 'a same-model batch must not be denied');
  assert.equal(same.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
});

// The collapsed executor name carries no effort, so name-vs-marker auditing only
// applies to legacy per-effort executors; on the collapsed def the marker owns effort
// and the prepared-spawn comparison audits it against the board.
test('pre-tool hook: legacy per-effort executor still rejects a route marker with different effort', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-mismatch',
      prompt: 'work SQ-377\n[sidequest-route model=codex-gpt-5-6-terra effort=medium]',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /executor effort "high" does not match route marker effort "medium"/);
});

test('pre-tool hook: the collapsed dispatch executor accepts any marker effort', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-collapsed',
      prompt: 'work SQ-377\n[sidequest-route model=codex-gpt-5-6-terra effort=medium]',
    },
  });
  assert.notEqual(out?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('pre-tool hook: prepared codex dispatch accepts the gateway-form route marker (SQ-753)', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-marker-form-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }],
  }));
  const previousDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
  try {
    const ticket = fixtureTicket('SQ-753 marker form regression', 'codex-gpt-5-6-terra', 'high');
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `marker-form-${++sqSeq}` });
    assert.equal(prepared.ticket.dispatch.route.model, 'codex-gpt-5-6-terra');
    assert.equal(prepared.ticket.dispatch.route.marker, 'gpt-5.6-terra');

    const projectPath = store.readMeta(slug).path;
    const base = {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: prepared.ticket.dispatch.launchName,
      description: prepared.ticket.dispatch.description,
      prompt: `Ref: ${ticket.ref}\n[sidequest-route model=gpt-5.6-terra effort=high]\n--project "${projectPath}" --token ${prepared.token}`,
    };
    const exact = runForceBypassWithEnv(base, { SIDEQUEST_DISCOVERY_DIRS: catalog });
    assert.ok(!exact.hookSpecificOutput.permissionDecision, 'the production marker form must be allowed');
    assert.equal(exact.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

    const drifted = runForceBypassWithEnv(
      { ...base, prompt: base.prompt.replace('model=gpt-5.6-terra', 'model=gpt-5.6-sol') },
      { SIDEQUEST_DISCOVERY_DIRS: catalog }
    );
    assert.equal(drifted.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(drifted.hookSpecificOutput.permissionDecisionReason, /ticket resolved route is codex-gpt-5-6-terra \/ high/);
    assert.match(drifted.hookSpecificOutput.permissionDecisionReason, /cannot be overridden at spawn time/);
  } finally {
    if (previousDirs === undefined) delete process.env.SIDEQUEST_DISCOVERY_DIRS;
    else process.env.SIDEQUEST_DISCOVERY_DIRS = previousDirs;
  }
});

test('pre-tool hook: prepared dispatches correct cosmetic spawn drift and reject integrity drift', () => {
  const ticket = addEffortTicket('correct prepared dispatch spawn drift', 'high');
  const sessionId = `description-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const projectPath = store.readMeta(slug).path;
  const description = prepared.ticket.dispatch.description;
  assert.equal(description, `Claude Sonnet, high · ${ticket.title}`);
  const prompt = `Ref: ${ticket.ref}\n--project "${projectPath}" --token ${prepared.token}`;
  const expectedName = `${ticket.ref.toLowerCase()}-correct-prepared`;
  assert.equal(prepared.ticket.dispatch.launchName, expectedName);
  const base = {
    subagent_type: prepared.ticket.dispatchExecutor,
    name: expectedName,
    description,
    prompt,
  };

  const exact = runHookOutput(FORCE_BYPASS, { session_id: sessionId, tool_name: 'Agent', tool_input: base });
  assert.equal(exact.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(exact.hookSpecificOutput.updatedInput.description, description);
  assert.equal(exact.hookSpecificOutput.updatedInput.name, expectedName);

  const driftedDescription = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: { ...base, description: 'shorter paraphrase' },
  });
  assert.equal(driftedDescription.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(driftedDescription.hookSpecificOutput.updatedInput.description, description);
  assert.match(driftedDescription.systemMessage, /corrected prepared dispatch description/);

  const driftedName = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: { ...base, name: 'drifted-agent-name' },
  });
  assert.equal(driftedName.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(driftedName.hookSpecificOutput.updatedInput.name, expectedName);
  assert.match(driftedName.systemMessage, /corrected prepared dispatch name/);

  const driftedRoute = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      ...base,
      subagent_type: 'sidequest-exec-dispatch',
      prompt: `${prompt}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]`,
    },
  });
  assert.equal(driftedRoute.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(driftedRoute.hookSpecificOutput.permissionDecisionReason, /ticket resolved route is sonnet \/ high/);
  assert.match(driftedRoute.hookSpecificOutput.permissionDecisionReason, /Set this ticket's route override before dispatching/);

  const driftedBriefing = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      ...base,
      subagent_type: 'sidequest-exec-dispatch',
      prompt: `[sidequest-route model=sonnet effort=high]\nFIRST action: run \`node "sidequest-launcher.js" brief ${ticket.ref} --token ${prepared.token} --project "${projectPath}"\``,
    },
  });
  assert.equal(driftedBriefing.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(driftedBriefing.hookSpecificOutput.permissionDecisionReason, /briefing command must match the prepared spawn/);

  store.prepareDispatch(slug, ticket.ref, { sessionId });
  const staleToken = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: base,
  });
  assert.equal(staleToken.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(staleToken.hookSpecificOutput.permissionDecisionReason, /token is stale or rotated/);

  const ordinary = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-high',
      model: 'sonnet',
      description: 'ordinary executor launch',
      prompt: 'Read one file.',
    },
  });
  assert.equal(ordinary.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(ordinary.hookSpecificOutput.updatedInput.description, 'ordinary executor launch');
});

test('dispatch ledger records an authoritative launch, agent bind, and claim acknowledgement', () => {
  const ticket = addEffortTicket('dispatch launch acknowledgement', 'high');
  const sessionId = `launch-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const projectPath = store.readMeta(slug).path;
  const prompt = `Work ${ticket.ref} --project "${projectPath}" --token ${prepared.token}`;
  const launch = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'dispatch-ledger',
      description: prepared.ticket.dispatch.description,
      prompt,
    },
  });
  const agentName = launch.hookSpecificOutput.updatedInput.name;
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'launched');
  runHookOutput(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-launch-1',
    agent_name: agentName,
  });
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, 'native-launch-1');
  assert.equal(store.claimTicket(slug, ticket.ref, 'dispatch-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.outcome, 'claimed');
  assert.equal(pulse.dispatch.tokenPrefix, prepared.token.slice(0, 12));
  assert.equal(pulse.dispatch.agentName, agentName);
});

test('readonly category executors pass spawn correction, start binding, and stop verdict hooks', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-readonly-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]' }],
  }));
  const previousDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
  try {
    const cases = [
      ['codebase-exploration', 'sonnet', 'low', 'sidequest-exec-readonly-low'],
      ['research', 'codex-gpt-5-6-sol', 'medium', 'sidequest-exec-dispatch-readonly'],
      ['review-audit', 'sonnet', 'high', 'sidequest-exec-readonly-high'],
      ['spike-investigation', 'codex-gpt-5-6-sol', 'xhigh', 'sidequest-exec-dispatch-readonly'],
    ] as const;
    const projectPath = store.readMeta(slug).path;

    for (const [category, model, effort, expectedExecutor] of cases) {
      store.setCategory({ id: category, name: category, route: { model, effort }, fallback: null, readonly: true, enabled: true });
      const ticket = store.createTicket(slug, { title: `readonly ${category} hook fixture`, category, source: 'cli' });
      const sessionId = `readonly-${category}-${++sqSeq}`;
      const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
      assert.equal(prepared.ticket.dispatchExecutor, expectedExecutor);
      const marker = expectedExecutor.includes('dispatch')
        ? `\n[sidequest-route model=${prepared.ticket.dispatch.route.marker} effort=${effort}]`
        : '';
      const prompt = `Ref: ${ticket.ref}${marker}\n--project "${projectPath}" --token ${prepared.token}`;
      const launch = runHookOutput(FORCE_BYPASS, {
        session_id: sessionId,
        tool_name: 'Agent',
        tool_input: {
          subagent_type: expectedExecutor,
          model,
          name: 'drifted-readonly-name',
          description: 'drifted readonly description',
          prompt,
        },
      });
      assert.equal(launch.hookSpecificOutput.permissionDecision, undefined);
      assert.equal(launch.hookSpecificOutput.updatedInput.description, prepared.ticket.dispatch.description);
      assert.match(launch.systemMessage, /corrected prepared dispatch description/);

      const agentId = `readonly-agent-${category}`;
      const agentName = launch.hookSpecificOutput.updatedInput.name;
      runHookOutput(SUBAGENT_START, {
        session_id: sessionId,
        agent_type: expectedExecutor,
        agent_id: agentId,
        agent_name: agentName,
      });
      assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, agentId);
      assert.equal(store.claimTicket(slug, ticket.ref, `readonly-worker-${category}`, {
        sessionId,
        token: prepared.token,
        executor: expectedExecutor,
      }).ok, true);
      const verdict = runHook(SUBAGENT_STOP, {
        session_id: sessionId,
        agent_type: expectedExecutor,
        agent_id: agentId,
        agent_name: agentName,
      });
      assert.match(verdict, new RegExp(`^exec WAITING: ${ticket.ref} ended a turn while holding its claim; it may resume\.`));
    }
  } finally {
    if (previousDirs === undefined) delete process.env.SIDEQUEST_DISCOVERY_DIRS;
    else process.env.SIDEQUEST_DISCOVERY_DIRS = previousDirs;
  }
});

test('concurrent same-type dispatches isolate launch, bind, claim, and stop by token-derived native identity', () => {
  const first = addEffortTicket('first same-type dispatch', 'high');
  const second = addEffortTicket('second same-type dispatch', 'high');
  const sessionId = `concurrent-${++sqSeq}`;
  const projectPath = store.readMeta(slug).path;
  const preparedFirst = store.prepareDispatch(slug, first.ref, { sessionId });
  const preparedSecond = store.prepareDispatch(slug, second.ref, { sessionId });
  const launches = [preparedFirst, preparedSecond].map((prepared) => runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'sidequest-exec-dispatch',
      description: prepared.ticket.dispatch.description,
      prompt: `Work ${prepared.ticket.ref} --project "${projectPath}" --token ${prepared.token}`,
    },
  }));
  const names = launches.map((launch) => launch.hookSpecificOutput.updatedInput.name);
  assert.notEqual(names[0], names[1]);
  assert.equal(names[0], `${first.ref.toLowerCase()}-first-same-type`);
  assert.equal(names[1], `${second.ref.toLowerCase()}-second-same-type`);
  for (const name of names) assert.doesNotMatch(name, /[A-Z_]|-[a-z0-9]{8,}$/, `${name} still reads as an opaque id`);

  for (const [index, prepared] of [preparedFirst, preparedSecond].entries()) {
    runHookOutput(SUBAGENT_START, {
      session_id: sessionId,
      agent_type: prepared.ticket.dispatchExecutor,
      agent_id: `native-concurrent-${index + 1}`,
      agent_name: names[index],
    });
    assert.equal(store.getTicket(slug, prepared.ticket.ref).dispatch.agentId, `native-concurrent-${index + 1}`);
    assert.equal(store.claimTicket(slug, prepared.ticket.ref, `concurrent-worker-${index + 1}`, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
  }

  const firstStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedFirst.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-1',
    agent_name: names[0],
  });
  assert.match(firstStop, new RegExp(`^exec WAITING: ${first.ref} ended a turn while holding its claim; it may resume\.`));
  assert.equal(store.getTicket(slug, first.ref).dispatch.outcome, 'claimed');
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'claimed');

  const secondStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedSecond.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-2',
  });
  assert.match(secondStop, new RegExp(`^exec WAITING: ${second.ref} ended a turn while holding its claim; it may resume\.`));
  assert.doesNotMatch(secondStop, new RegExp(`${first.ref}.*(?:release \\+ fresh dispatch|TaskStop)`));
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'claimed');
});

test('session start reconciles a reload-lost launch once and leaves it ready to respawn', () => {
  const ticket = addEffortTicket('reload before claim', 'high');
  const sessionId = `reload-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'lost-native-task',
  }).ok, true);
  const first = runHook(SESSION, { session_id: sessionId, source: 'resume' });
  assert.match(first, new RegExp(`${ticket.ref} launched but never claimed`));
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.status, 'todo');
  assert.equal(after.dispatch.outcome, 'failed');
  assert.equal(after.dispatchNonce, null);
  assert.deepStrictEqual(store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' }).reconciled, []);
  const second = runHook(SESSION, { session_id: sessionId, source: 'resume' });
  assert.ok(!second.includes('launched but never claimed'));
});

test('subagent stop records a turn end for a launch that has not claimed yet', () => {
  const ticket = addEffortTicket('stop before claim', 'high');
  const sessionId = `stop-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'native-stop-1', 'stop-before-claim').ok, true);
  const context = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-stop-1',
    agent_name: 'stop-before-claim',
  });
  assert.equal(context, '');
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatch.outcome, 'launched');
  assert.ok(after.dispatch.turnEndedAt);
  assert.equal(after.dispatchNonce, prepared.token);
});

test('subagent-stop: legacy ticket executors without identity stay silent', () => {
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: 'sess-legacy-ticket', agent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb' }),
    ''
  );
});

test('pre-tool hook: dispatch executor requires a canonical route marker and legacy executors cannot launch', () => {
  const missingMarker = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-no-marker', prompt: 'work SQ-377' },
  });
  assert.equal(missingMarker.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    missingMarker.hookSpecificOutput.permissionDecisionReason,
    "sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged."
  );

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'w-builtin-no-marker', prompt: 'work SQ-377' },
  });
  assert.ok(!builtIn.hookSpecificOutput.permissionDecision, 'markerless builtin executors remain valid');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const legacy = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb', name: 'w-legacy', prompt: 'work SQ-377' },
  });
  assert.equal(legacy.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(legacy.hookSpecificOutput.permissionDecisionReason, /invalid or retired/);
});
