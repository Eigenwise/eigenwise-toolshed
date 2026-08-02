import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
const GUARD_BASH_WINDOWS_PATHS = path.join(HOOKS, 'guard-bash-windows-paths.js');
const NEAR_TURN_CAP = path.join(HOOKS, 'near-turn-cap.js');
const REPEATED_COMMAND_WARN = path.join(HOOKS, 'repeated-command-warn.js');
const INLINE_WORK_NUDGE = path.join(HOOKS, 'inline-work-nudge.js');
const BOARD_FIRST_REMINDER = path.join(HOOKS, 'board-first-reminder.js');
const BOARD_RECONCILIATION_REMINDER = path.join(HOOKS, 'board-reconciliation-reminder.js');
const GUARD_TASK_OUTPUT = path.join(HOOKS, 'guard-task-output.js');
const GUARD_SHARED_TREE_COMMIT = path.join(HOOKS, 'guard-shared-tree-commit.js');
const GUARD_OVERSIZED_SKILL = path.join(HOOKS, 'guard-oversized-skill.js');

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

test('pre-tool hook: oversized bundled skills are denied for dispatched executors only', () => {
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-bundled-skills-'));
  const skill = path.join(skills, 'claude-api');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), Buffer.alloc(256 * 1024 + 1));
  const payload = {
    tool_name: 'Skill',
    tool_input: { skill: 'claude-api' },
    agent_type: 'sidequest-exec-dispatch-high',
  };

  const blocked = runHookOutput(GUARD_OVERSIZED_SKILL, payload);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /claude-api/);
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /targeted Read/);
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /research ticket/);

  const futureSkill = path.join(skills, 'reference-monolith');
  fs.mkdirSync(futureSkill);
  fs.writeFileSync(path.join(futureSkill, 'SKILL.md'), Buffer.alloc(256 * 1024 + 1));
  const future = runHookOutput(GUARD_OVERSIZED_SKILL, {
    ...payload,
    tool_input: { skill: 'reference-monolith' },
  }, { SIDEQUEST_BUNDLED_SKILLS_DIR: skills });
  assert.equal(future.hookSpecificOutput.permissionDecision, 'deny');

  assert.equal(runHookOutput(GUARD_OVERSIZED_SKILL, {
    tool_name: 'Skill',
    tool_input: { skill: 'claude-api' },
  }, { SIDEQUEST_BUNDLED_SKILLS_DIR: skills }), null);
});

test('executor template calls transcript evidence self-reference', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'scripts', '_exec-template.md'), 'utf8');
  assert.match(template, /Evidence work that needs session, transcript, or task-output searching is not helper work/);
  assert.match(template, /a match there is self-reference, not evidence/);
  assert.match(template, /report a visibility block rather than a finding/);
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
  for (const command of ['rm -rf /', 'rm -rf C:\\scratchpad\\observability /']) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('home-delete guard: allows scratchpad deletion', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force C:\\scratchpad\\run-42'), null);
});

test('home-delete guard: allows non-delete PowerShell commands', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Get-ChildItem $HOME'), null);
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

test('session-start: stays inside its byte budget and off the retired doctrine', () => {
  const ctx = runHookForBudget(SESSION, { session_id: 'test' });
  assert.ok(
    ctx.length <= BUDGET.session,
    `session block is ${ctx.length} chars — budget is ${BUDGET.session}; trim it, don't raise the budget`
  );
  assertNoRetiredDoctrine(ctx, 'session-start');
});

// The sweep's cost is bimodal, so the hook hands it to a detached worker and waits
// only up to a deadline. These pin the deadline path: a slow sweep must cost the
// session its notices, never its whole injected context.
function sweepReportFile(home: string, cwd: string): string {
  const key = require('node:crypto').createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(home, 'sweep-reports', `${key}.json`);
}

test('session-start: SIDEQUEST_NUDGE=off silences it', () => {
  const out = execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_NUDGE: 'off' },
  });
  assert.strictEqual(out.trim(), '', 'should emit nothing when nudge is off');
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

// Registered LAST: creates extra fixture categories, which would otherwise grow
// the taxonomy line inside earlier byte-budget assertions.