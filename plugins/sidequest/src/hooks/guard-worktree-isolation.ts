#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import {
  bindObservedRuntimeIdentity,
  canonicalPath,
  enclosingCheckout,
  executorAgent,
  isolationExpectation,
  type IsolationExpectation,
} from './shared/runtime-identity.js';

const leaseKernel = require(runtimeModule('kernel/worktree')) as {
  createWorktreeLease: (facts: unknown) => unknown;
  worktreeWriteDecision: (lease: unknown, target: string) => { allowed: boolean; reason: string };
};

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function targetPath(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return '';
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? '' : String(value);
  return target && path.isAbsolute(target) ? path.resolve(target) : '';
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const resolved = canonicalPath(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function observedWorktreeLease(found: IsolationExpectation | null, worktree: string, agentId: string) {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: worktree,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const gitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(worktree, value);
  const repository = found?.projectPath || worktree;
  return leaseKernel.createWorktreeLease({
    repository,
    gitDirectory: gitPath(git(['rev-parse', '--git-dir'])),
    commonGitDirectory: gitPath(git(['rev-parse', '--git-common-dir'])),
    dispatchRef: found?.ref || null,
    dispatchBaseline: found?.dispatchBaseline || null,
    observedRevision: git(['rev-parse', '--verify', 'HEAD^{commit}']),
    observedWorktree: worktree,
    boundRevision: found?.expectedRevision || null,
    boundWorktree: found?.sharedTree ? found.projectPath : found?.expectedWorktree || null,
    boundGitDirectory: found?.sharedTree ? null : found?.expectedGitDirectory || null,
    boundCommonGitDirectory: found?.sharedTree ? null : found?.expectedCommonGitDirectory || null,
    boundCheckoutInstance: found?.sharedTree ? null : found?.expectedCheckoutInstance || null,
    identity: found?.identityBound ? { status: 'bound', agentId } : { status: 'unknown' },
    phase: found?.terminal ? 'terminal' : found?.phase || 'created',
    locked: false,
    liveness: found?.terminal
      ? { status: 'terminal', evidence: 'the dispatch is terminal' }
      : found ? { status: 'live', evidence: `dispatch ${found.ref} is active` } : { status: 'unknown', evidence: 'no dispatch matched this agent' },
    provisioning: 'host',
  });
}

function expectedWorktree(found: IsolationExpectation): string {
  if (found.sharedTree && found.projectPath) return found.projectPath;
  return found.expectedWorktree || '(immutable worktree binding unavailable)';
}

function boundedText(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const suffix = '…';
  let result = '';
  let bytes = Buffer.byteLength(suffix, 'utf8');
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

function boundedRefusal(summary: string, facts: Array<[string, string]>, recovery: string): string {
  const detailLimit = recovery.startsWith('Use the worktree assigned') ? 140 : 100;
  const factLines = facts.map(([label, value]) => `  ${label}: ${boundedText(value, label === 'writing to' ? 60 : detailLimit)}`);
  return [
    `sidequest: refusing this write. ${boundedText(summary, 180)}`,
    ...factLines,
    `Recovery: ${recovery}`,
  ].join('\n');
}

// The refusal has to be usable by an agent that believes it is isolated: name
// the ticket, the tree it was promised, the tree it is actually writing to, and
// the one move that saves the work. Losing the worktree is a platform failure,
// not executor misbehaviour, so the message must not read like an accusation.
function refusal(found: IsolationExpectation, target: string, repoRoot: string, cwd: string): string {
  const expected = expectedWorktree(found);
  const sharedCheckout = `${repoRoot}${cwd && !samePath(cwd, repoRoot) ? ` (cwd ${cwd})` : ''}`;
  return boundedRefusal(
    `${found.ref} was dispatched with worktree isolation, but this write lands in the SHARED checkout.`,
    [['expected worktree', expected], ['writing to', target], ['shared checkout', sharedCheckout]],
    `This is a harness worktree-loss failure, not executor behavior. Stop writing, tell the orchestrator "${found.ref} lost its worktree, re-dispatch it", and leave the shared tree untouched. Report any staged work.`,
  );
}

function terminalRefusal(found: IsolationExpectation, target: string): string {
  return boundedRefusal(
    `${found.ref} already reached a terminal board state, so this executor has no legal write target.`,
    [['writing to', target]],
    'Do not work around this or re-arm any Monitor. Stop owned background tasks and end this executor. Redispatch the ticket if more work is needed.',
  );
}

function unknownRefusal(target: string): string {
  return boundedRefusal(
    'This executor has no active dispatch record for a shared-checkout write.',
    [['writing to', target]],
    'Do not work around this. Stop any owned background tasks and end the executor. Redispatch before making more changes.',
  );
}

function projectRefusal(found: IsolationExpectation, target: string): string {
  return boundedRefusal(
    `${found.ref} belongs to a different project than this target.`,
    [['writing to', target]],
    'Do not work around this. End the executor and redispatch the ticket for the correct project.',
  );
}

function leaseRefusal(found: IsolationExpectation | null, target: string, reason: string): string {
  return boundedRefusal(
    `${found?.ref || 'This executor'} has no write lease for the observed worktree.`,
    [['writing to', target], ['lease decision', reason]],
    'Do not work around this. Stop writing and ask the orchestrator to redispatch the ticket.',
  );
}

function linkedWorktreeLeaseRefusal(found: IsolationExpectation, target: string, actualRoot: string, reason: string): string {
  return boundedRefusal(
    `${found.ref} has no write lease for this linked worktree.`,
    [['expected worktree', found.expectedWorktree || '(unavailable)'], ['actual worktree', actualRoot], ['writing to', target], ['lease decision', reason]],
    'Use the worktree assigned to this executor. If it no longer exists, stop and ask the orchestrator to redispatch the ticket.',
  );
}

function main(): void {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, 'tool_name'))) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;

  const target = targetPath(input);
  if (!target) return;
  const repo = enclosingCheckout(path.dirname(canonicalPath(target)));
  if (!repo) return;
  let found = isolationExpectation(input, agentId, executor);
  if (!found?.terminal && !found?.identityBound && repo.linked) {
    bindObservedRuntimeIdentity(input, agentId, executor, repo.root);
    found = isolationExpectation(input, agentId, executor);
  }
  if (found?.terminal) {
    writeDeny('PreToolUse', terminalRefusal(found, target));
    return;
  }
  if (!found) {
    try {
      const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(null, repo.root, agentId), target);
      if (!decision.allowed) writeDeny('PreToolUse', unknownRefusal(target));
    } catch (_) {
      writeDeny('PreToolUse', unknownRefusal(target));
    }
    return;
  }
  try {
    const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(found, repo.root, agentId), target);
    if (!decision.allowed) {
      const message = !found.sharedTree && repo.linked
        ? linkedWorktreeLeaseRefusal(found, target, repo.root, decision.reason)
        : !found.sharedTree
          ? refusal(found, target, repo.root, stringField(input, 'cwd'))
          : leaseRefusal(found, target, decision.reason);
      writeDeny('PreToolUse', message);
    }
  } catch (_) {
    writeDeny('PreToolUse', leaseRefusal(found, target, 'the observed Git facts could not hydrate a lease.'));
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
