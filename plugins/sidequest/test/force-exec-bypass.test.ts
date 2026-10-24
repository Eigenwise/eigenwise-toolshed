import './hooks.test.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellSegments, namesShellWrite } from '../src/hooks/shared/shell-writes.js';
import { readOnlyShellRefusal } from '../src/hooks/shared/read-only-shell.js';
import { gitInvocations, shellTokens } from '../hooks/guards/git-command.js';
import { isReadOnlyGit } from '../src/hooks/shared/read-only-git.js';

const SHARED_GIT_READS = [
  'status --porcelain -- bin/docai_refactored app routes', 'log', 'show HEAD', 'diff',
  'rev-parse --git-dir', 'rev-list HEAD', 'ls-files', 'ls-tree HEAD', 'cat-file -p HEAD',
  'branch', 'branch --list feature*', 'branch --show-current', 'worktree list',
  'remote -v', 'describe', 'blame README.md',
];
const SHARED_GIT_WRITES = [
  'add .', 'checkout other', 'worktree add other', 'worktree remove other', 'worktree move a b',
  'worktree prune', 'stash', 'branch other', 'branch --list --delete other', 'remote add other url',
  'diff --output=result', 'unknown-command',
];

test('SQ-3835: shared-checkout git reads pass shell and executor admission predicates', () => {
  for (const suffix of SHARED_GIT_READS) {
    const command = `git -C "C:/shared checkout" -c color.ui=false ${suffix}`;
    assert.equal(namesShellWrite(command), false, command);
    assert.equal(readOnlyShellRefusal(command, process.cwd()), null, command);
    const invocation = gitInvocations(command)[0]!;
    assert.ok(invocation, command);
    assert.equal(isReadOnlyGit(invocation.subcommand, shellTokens(invocation.args)), true, command);
  }
});

test('SQ-3835: shared-checkout mutations retain the read-only refusal after global flags', () => {
  for (const suffix of SHARED_GIT_WRITES) {
    const command = `git -C "C:/shared checkout" -c color.ui=false ${suffix}`;
    assert.equal(namesShellWrite(command), true, command);
    assert.match(readOnlyShellRefusal(command, process.cwd())!, /read-only executor, refusing a git mutation/, command);
    const invocation = gitInvocations(command)[0]!;
    assert.equal(isReadOnlyGit(invocation.subcommand, shellTokens(invocation.args)), false, command);
  }
});

const ISSUE_641_READS = [
  'merge-base HEAD main', 'merge-base --is-ancestor HEAD main', 'grep pattern',
  'for-each-ref refs/heads', 'show-ref --verify refs/heads/main', 'config --get user.name',
  'config --get-all remote.origin.fetch', 'config --list', 'config -l', 'config --local --get user.name',
  'shortlog -sn HEAD', 'reflog', 'reflog show HEAD', 'reflog HEAD', 'stash list', 'stash show -p',
  'tag --list', 'tag -l v*', 'tag --contains HEAD', 'tag --points-at=HEAD',
  'remote show origin', 'remote get-url origin', 'remote -v', 'ls-remote origin', 'name-rev HEAD',
  'count-objects -v', 'check-ignore file', 'check-attr -a file', 'diff-tree HEAD', 'diff-index HEAD',
];
const ISSUE_641_WRITES = [
  'commit -m message', 'branch -D feature', 'tag version', 'tag --list --delete version',
  'tag --contains HEAD --force version', 'stash push', 'stash pop', 'config user.name other',
  'config --get user.name other', 'config --get user.name --replace-all', 'config --list --unset user.name',
  'config --get-all user.name other', 'reflog expire --all', 'reflog delete HEAD@{0}',
  'reflog drop HEAD', 'reflog write HEAD old new message', 'remote add origin url',
  'remote -v add origin url', 'remote set-url origin url', 'update-ref refs/heads/main HEAD', 'archive -o output.tar HEAD',
  'grep --output=result pattern', 'for-each-ref --output result',
];

test('GH-641: read-only Git queries pass with plain and directory-prefixed commands', () => {
  for (const prefix of ['git', 'git -C "C:/shared checkout"']) {
    for (const suffix of ISSUE_641_READS) {
      const command = prefix + ' ' + suffix;
      assert.equal(namesShellWrite(command), false, command);
      assert.equal(readOnlyShellRefusal(command, process.cwd()), null, command);
    }
  }
});

test('GH-641: Git mutations remain refused with plain and directory-prefixed commands', () => {
  for (const prefix of ['git', 'git -C "C:/shared checkout"']) {
    for (const suffix of ISSUE_641_WRITES) {
      const command = prefix + ' ' + suffix;
      assert.equal(namesShellWrite(command), true, command);
      assert.match(readOnlyShellRefusal(command, process.cwd())!, /read-only-git\.ts/, command);
    }
  }
});

test('SQ-3808: heredoc bodies never become shell write targets', () => {
  assert.deepEqual(shellSegments("cat > /scratch/probe.py <<'EOF'\ndef f() -> int:\n    return 2 > 1\nEOF").flatMap((segment) => segment.redirects), ['/scratch/probe.py']);
  assert.deepEqual(shellSegments('cat > repo/probe.py <<"EOF"\ndef f() -> int:\nEOF').flatMap((segment) => segment.redirects), ['repo/probe.py']);
  for (const command of [
    'cat <<-EOF\n\tdef f() -> int:\n\tEOF',
    'cat <<FIRST <<"SECOND"\nx > fake\nFIRST\ny > other\nSECOND',
    'cat <<EOF\ndef f() -> int:',
    'cat <<< "x > fake"',
    'cat <<<bare',
    'cat <<',
    "cat <<'E.O[F]'\r\nx > fake\r\nE.O[F]\r\n",
    "cat <<''\nx > fake\n\n",
  ]) assert.equal(namesShellWrite(command), false, command);
  assert.equal(namesShellWrite('cat <<EOF\nx > fake\nEOF\necho x > real'), true);
  assert.equal(namesShellWrite('cat <<EOF\nx > fake\nEOF\ngit reset --hard'), true);
  assert.deepEqual(shellSegments('cat <<-EOF\nx > fake\n EOF\n\tEOF\necho x > real').flatMap((segment) => segment.redirects), ['real']);
  assert.deepEqual(shellSegments('cat <<FIRST <<SECOND\nx > fake\nFIRST\ny > other\nSECOND\necho x > real').flatMap((segment) => segment.redirects), ['real']);
  assert.deepEqual(shellSegments('cat <<<"data > fake" > real 2>&1').flatMap((segment) => segment.redirects), ['real']);
});

test('SQ-3808: force-exec-bypass allows scratch heredocs and refuses the real repository redirect', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-heredoc-repo-'));
  fs.mkdirSync(path.join(root, '.git'));
  const scratch = path.join(os.tmpdir(), 'sq-heredoc-probe.py').replaceAll('\\', '/');
  const command = `cat > "${scratch}" <<'EOF'\ndef f() -> int:\n    return 2 > 1\nEOF`;
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  for (const [input, denied] of [[command, false], [command.replace(scratch, 'probe.py'), true]] as const) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'heredoc-reader', agent_type: 'sidequest-exec-readonly-high', cwd: root, tool_name: 'Bash', tool_input: { command: input } }),
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('"permissionDecision":"deny"'), denied, result.stdout);
    if (denied) assert.ok(result.stdout.includes('probe.py'));
  }
});

test('correction host hook denies subagents including malformed correct and permits trusted main', () => {
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  const cases = [
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: {} }, denied: true, message: 'subagents cannot finalize or correct completed review verdicts' },
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: null }, denied: true, message: 'subagents cannot finalize or correct completed review verdicts' },
    { agent_id: '', tool_name: 'verdict', tool_input: { correct: {} }, denied: false, message: '' },
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { outcome: 'accepted' }, denied: false, message: '' },
    { agent_id: 'synthetic-subagent', tool_name: 'update', tool_input: { files: ['synthetic.js'] }, denied: true, message: 'subagents cannot update closeout fields' },
    { agent_id: 'synthetic-subagent', tool_name: 'remove', tool_input: { force: true }, denied: true, message: 'subagents cannot force-remove a ticket' },
  ];
  for (const entry of cases) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', ...entry, tool_name: `mcp__plugin_sidequest_board__${entry.tool_name}` }),
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('"permissionDecision":"deny"'), entry.denied);
    if (entry.denied) assert.equal(result.stdout.includes(entry.message), true);
  }
});

function preToolUseDecision(agentId: string, sessionId: string, toolInput: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: agentId, session_id: sessionId,
      tool_name: 'mcp__plugin_sidequest_board__update', tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'composition-main-session', CLAUDE_SESSION_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('composition admission host hook denies subagent probes and grants, even with the main session id, and permits trusted main', () => {
  const probe = { ref: 'SQ-1', admitComposition: { authority: 'main-attestation', historicalCheckout: false } };
  const grant = { ref: 'SQ-1', admitComposition: { ...probe.admitComposition, expected: { attemptCount: 1 } } };
  for (const [sessionId, toolInput] of [['subagent-session', probe], ['composition-main-session', grant]] as const) {
    const denied = preToolUseDecision('synthetic-subagent', sessionId, toolInput);
    assert.equal(denied.includes('"permissionDecision":"deny"'), true);
    assert.equal(denied.includes('admit a composition'), true);
  }
  assert.equal(preToolUseDecision('', 'composition-main-session', grant).includes('"permissionDecision":"deny"'), false);
});


test('work provenance host hook rejects a worker declaration under the main session and permits the main thread', () => {
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  const declaration = { ref: 'SQ-1', workProvenance: { kind: 'inherited-read-only', sources: [] } };
  const worker = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'synthetic-worker',
    session_id: 'synthetic-main', tool_name: 'mcp__plugin_sidequest_board__dispatch', tool_input: declaration }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(worker.status, 0, worker.stderr);
  assert.match(worker.stdout, /subagents cannot declare work provenance/);
  const main = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: '',
    session_id: 'synthetic-main', tool_name: 'mcp__plugin_sidequest_board__dispatch', tool_input: declaration }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(main.status, 0, main.stderr);
  assert.equal(main.stdout.includes('"permissionDecision":"deny"'), false);
});

function nativeAgentDecision(toolInput: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('native read-only agents need no ticket or board dispatch', () => {
  for (const subagent_type of ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'fork', 'custom-reader']) {
    assert.equal(nativeAgentDecision({ subagent_type, description: 'Locate call sites', prompt: 'Find callers and report source paths.' }), '', subagent_type);
  }
  assert.equal(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Read the file. Do not edit it.' }), '');
  assert.equal(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Find the commit that changed the hook and report its hash.' }), '');
});

test('native route markers require dispatch even for Explore', () => {
  for (const subagent_type of ['general-purpose', 'Explore', 'Plan']) {
    assert.match(nativeAgentDecision({ subagent_type, prompt: '[sidequest-route model=sonnet effort=medium ticket=SQ-1] Read files.' }),
      /requests write or ticket work without a prepared dispatch/);
  }
});

test('read-only native agents may cite ticket refs as lookup context but not to write them', () => {
  const triage = 'Triage open GitHub issues. Flag duplicates of SQ-3502 and SQ-3043 and report links.';
  for (const subagent_type of ['Explore', 'Plan', 'claude-code-guide']) {
    assert.equal(nativeAgentDecision({ subagent_type, prompt: triage }), '', subagent_type);
    assert.equal(nativeAgentDecision({ subagent_type, description: 'Inspect SQ-1', prompt: 'Read files.' }), '', subagent_type);
    assert.match(nativeAgentDecision({ subagent_type, prompt: 'Edit SQ-1234 to fix the hook.' }),
      /requests write or ticket work without a prepared dispatch/, subagent_type);
  }
});

test('write-capable native agents citing only a ticket ref are refused with the read-only alternative', () => {
  for (const subagent_type of ['general-purpose', 'custom-reader']) {
    const decision = nativeAgentDecision({ subagent_type, prompt: 'Inspect SQ-3643.' });
    assert.match(decision, /cites a ticket ref without a prepared dispatch/, subagent_type);
    assert.match(decision, /spawn Explore, Plan, claude-code-guide instead/, subagent_type);
  }
  assert.match(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Edit SQ-1234.' }),
    /requests write or ticket work without a prepared dispatch/);
});

test('native write intent and undispatched Sidequest executor remain refused', () => {
  for (const prompt of ['Edit the source.', 'Commit the patch.', 'Push the branch.', 'Install dependencies.']) {
    assert.match(nativeAgentDecision({ subagent_type: 'general-purpose', prompt }), /permissionDecision.*deny/);
  }
  assert.match(nativeAgentDecision({ subagent_type: 'custom-reader', description: 'Edit source', prompt: 'Read files.' }), /permissionDecision.*deny/);
  assert.match(nativeAgentDecision({ subagent_type: 'sidequest:sidequest-exec-dispatch', prompt: 'Read files.' }), /exact prepared FIRST action briefing command/);
});

const RESEARCH_LINE = 'Read-only research run, no ticket: deliver your findings as your final message; do not claim, comment or write.';

function researchDecision(project: string, toolInput: Record<string, unknown>, projectDirectory = project, requestedProject?: string): { denied: boolean; reason: string; updatedInput: Record<string, unknown> | undefined } {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, project: requestedProject, tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_SUBAGENT_MODEL: '', CLAUDE_PROJECT_DIR: projectDirectory },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : {};
  return { denied: output.permissionDecision === 'deny', reason: String(output.permissionDecisionReason || ''), updatedInput: output.updatedInput };
}

test('SQ-3739: a read-only executor with a live category research prefix runs without a ticket', () => {
  const store = require('../lib/store.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-3739-research-'));
  const { slug } = store.ensureProject(project);
  store.setCategory({ id: 'sq3739-codex-research', name: 'sq3739-codex-research', route: { model: 'codex-gpt-6-1-sol', effort: 'medium' }, fallback: null, readonly: true, enabled: true });
  store.setCategory({ id: 'sq3739-claude-research', name: 'sq3739-claude-research', route: { model: 'haiku', effort: 'max' }, fallback: null, readonly: true, enabled: true });
  // Other suites share this profile, so their categories are switched off for this project; a stale marker must not stay live through one of them.
  for (const category of store.getCategories({ project: slug })) {
    if (category.enabled && category.id !== 'general' && !category.id.startsWith('sq3739-')) store.setProjectCategory(slug, category.id, 'DISABLE', {});
  }
  assert.notDeepEqual(store.getCategory('general', { project: slug }).route, { model: 'haiku', effort: 'max' }, 'general, which cannot be disabled, must not share the stale route');
  const codexPrompt = `[sidequest-route model=gpt-6.1-sol effort=medium]\n${RESEARCH_LINE}\n\nHow does the UX of the board page read? Edit nothing.`;
  const claudePrompt = `[sidequest-route model=haiku effort=max]\n${RESEARCH_LINE}\n\nFind every caller of routeMarker.`;

  const codex = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', model: 'opus', isolation: 'worktree', mode: 'bypassPermissions', description: 'UX research', prompt: codexPrompt });
  assert.equal(codex.denied, false, codex.reason);
  assert.equal(codex.updatedInput?.prompt, codexPrompt);
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'model'), false, 'the Codex definition pin selects the model');
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'isolation'), false, 'research runs in the parent tree');
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'mode'), false, 'a read-only executor never gets bypassPermissions');

  const claude = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-max', model: 'opus', description: 'Code research', prompt: claudePrompt });
  assert.equal(claude.denied, false, claude.reason);
  assert.equal(claude.updatedInput?.model, 'haiku', 'the Claude route model replaces the caller model');

  store.setCategory({ id: 'sq3739-claude-research', name: 'sq3739-claude-research', route: { model: 'haiku', effort: 'low' }, fallback: null, readonly: true, enabled: true });
  const stale = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-max', prompt: claudePrompt });
  assert.equal(stale.denied, true, 'a marker for a route the category no longer has is refused');
  assert.match(stale.reason, /live research prefix of an enabled category route/);
  const unknown = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', prompt: `[sidequest-route model=gpt-9-ghost effort=medium]\n${RESEARCH_LINE}\n\nLook around.` });
  assert.equal(unknown.denied, true, 'an unknown marker is refused');
  assert.match(unknown.reason, /live research prefix/);
  const wrongExecutor = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-high', prompt: codexPrompt });
  assert.equal(wrongExecutor.denied, true, 'the marker must belong to the spawned executor type');

  assert.equal(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch', prompt: codexPrompt }).denied, true, 'a writable Codex executor still needs a dispatch');
  assert.equal(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-low', model: 'sonnet', prompt: `[sidequest-route model=sonnet effort=low]\n${RESEARCH_LINE}\n\nRead.` }).denied, true, 'a writable Claude executor still needs a dispatch');
  assert.match(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', prompt: 'Read files.' }).reason, /exact prepared FIRST action briefing command/);
  assert.match(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-low', model: 'sonnet', prompt: 'Read files.' }).reason, /missing its dispatched ticket/);
});


test('evidence category keeps its ticketless readonly research recipe admissible', () => {
  const store = require('../lib/store.js');
  const agentsync = require('../lib/agentsync.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-recipe-'));
  const { slug } = store.ensureProject(project);
  const category = store.getCategory('research.evidence', { project: slug });
  const resolved = store.resolveCategoryRoute(category);
  const recipe = agentsync.workflowRecipe({ ...category, project: slug }, resolved);
  assert.equal(recipe.category, 'research.evidence');
  assert.ok(recipe.agent);
  assert.equal(recipe.research.subagentType, 'sidequest:sidequest-exec-readonly-medium');
  const decision = researchDecision(project, { subagent_type: recipe.research.subagentType, model: recipe.research.model, description: 'Evidence research', prompt: recipe.research.promptPrefix + 'Inspect only. Save nothing.' });
  assert.equal(decision.denied, false, decision.reason);
});


test('GH-602: research resolves subdirectories and linked worktrees without scanning task commands', () => {
  const store = require('../lib/store.js');
  const agentsync = require('../lib/agentsync.js');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-602-research-'));
  const project = path.join(fixture, 'repository');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-b', 'main', project], { windowsHide: true });
  execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture'], { windowsHide: true });
  const { slug } = store.ensureProject(project);
  const category = store.getCategory('research.evidence', { project: slug });
  const recipe = agentsync.workflowRecipe({ ...category, project: slug }, store.resolveCategoryRoute(category)).research;
  const prompt = recipe.promptPrefix + 'Inspect the quoted command: \x60node tool.js --project missing-board\x60. Write nothing.';
  const toolInput = { subagent_type: recipe.subagentType, model: recipe.model, prompt };
  const subdirectory = path.join(project, 'nested');
  fs.mkdirSync(subdirectory);
  const internalWorktree = path.join(project, 'linked');
  const externalWorktree = path.join(fixture, 'linked');
  for (const worktree of [internalWorktree, externalWorktree]) {
    execFileSync('git', ['-C', project, 'worktree', 'add', '--detach', worktree], { windowsHide: true });
  }
  for (const directory of [project, subdirectory, internalWorktree, externalWorktree]) {
    const decision = researchDecision(directory, toolInput);
    assert.equal(decision.updatedInput?.prompt, prompt, directory + ': ' + decision.reason);
  }
  assert.equal(researchDecision(subdirectory, toolInput, project).updatedInput?.prompt, prompt, 'cwd resolves with root CLAUDE_PROJECT_DIR');
  const unknown = researchDecision(fixture, toolInput);
  assert.equal(unknown.denied, true);
  assert.ok(unknown.reason.includes('could not resolve a registered project from cwd ' + fixture), unknown.reason);
  assert.equal(researchDecision(fixture, toolInput, fixture, slug).updatedInput?.prompt, prompt, 'explicit hook project selects a registered board');
  assert.equal(researchDecision(fixture, toolInput, fixture, subdirectory).updatedInput?.prompt, prompt, 'explicit hook path uses the shared root resolver');
  const wrongPrefix = researchDecision(project, { ...toolInput, prompt: prompt.replace('Read-only research run', 'Changed research run') });
  assert.equal(wrongPrefix.denied, true);
  assert.match(wrongPrefix.reason, /live research prefix/);
  store.setProjectRouting(slug, 'disabled');
  assert.match(researchDecision(subdirectory, toolInput).reason, /no usable executor route/, 'resolved research still respects disabled board routing');
});
