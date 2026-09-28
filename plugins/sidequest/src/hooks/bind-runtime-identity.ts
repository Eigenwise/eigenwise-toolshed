#!/usr/bin/env node
import { readStdin, stringField, isRecord, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { writeDeny } from './shared/output.js';
import {
  bindObservedRuntimeIdentity,
  enclosingCheckout,
  executorAgent,
  isolationExpectation,
} from './shared/runtime-identity.js';

// SQ-2159. The declared-write guard repairs a dispatch whose SubagentStart beat
// its own worktree creation, but a read-only executor never writes, so a review
// run stayed identity-less and its terminal done could not satisfy the
// independent candidate-review gate. Every executor reaches the board to claim
// and again to close, so a board call is the lifecycle event a read-only run
// necessarily makes while the binding can still be repaired. Nothing here can
// deny or rewrite the call: it only re-offers the checkout the harness put this
// agent in, and the store decides whether that is the exact reserved target.
function bindClaimRuntimeIdentity(input: HookInput, agentId: string, executor: string): boolean {
  if (stringField(input, 'tool_name') !== 'mcp__plugin_sidequest_board__claim' || !isRecord(input.tool_input)) return false;
  const toolInput = input.tool_input;
  const ref = String(toolInput.ref || '').trim();
  const sessionId = stringField(input, 'session_id', 'sessionId');
  if (!sessionId || !executorAgent(executor) || !ref || String(toolInput.executor || '').trim() !== executor) return true;
  try {
    const store = require(runtimeModule('store')) as {
      findProject: (project: string) => { ok?: boolean; slug?: string };
      sessionProjectRoot: () => string;
      bindClaimRuntimeIdentity: (slug: string, ref: string, options: unknown) => {
        ok?: boolean;
        reason?: string;
        message?: string;
        ticket?: { dispatch?: { reducedAgentSchema?: boolean } };
      };
    };
    // `project` is optional on claim. The MCP claim handler resolves an omitted
    // project through store.sessionProjectRoot, so the bind must use the same
    // authority (not the tool call's cwd, which is a worktree or an unrelated
    // checkout) or the legal no-project claim binds nothing and every later
    // shared-tree write is refused as an unknown identity.
    const project = String(toolInput.project || '').trim() || store.sessionProjectRoot();
    const found = store.findProject(project);
    if (found.ok && found.slug) {
      // The harness confines an isolated executor to the linked checkout it created, so the claim's cwd is the one
      // fact that can settle a crossed creation-order lease (SQ-55). The parent checkout proves nothing and is not sent.
      const cwd = stringField(input, 'cwd');
      const checkout = cwd ? enclosingCheckout(cwd) : null;
      const binding = store.bindClaimRuntimeIdentity(found.slug, ref, {
        observedWorktree: checkout?.linked ? checkout.root : null,
        token: toolInput.token,
        tokenFile: toolInput.tokenFile,
        executor,
        effort: toolInput.effort,
        agentId,
        permissionMode: stringField(input, 'permission_mode'),
        sessionId,
      });
      if (binding?.ticket?.dispatch?.reducedAgentSchema === true && !binding.ok) {
        writeDeny(
          'PreToolUse',
          binding.message || `sidequest: ${ref} reduced Agent-schema dispatch could not verify this hook-reported runtime identity (${binding.reason || 'unknown reason'}). Stop without claiming; use a host that reports agent_id and permission_mode ("auto" or "bypassPermissions") to PreToolUse. Do not add unsupported Agent fields or change permissions.`,
        );
      }
    }
  } catch (_) {
  }
  return true;
}

// A crossed executor's release is made from the checkout the harness confined it to, which can differ from the one its
// ticket records (SQ-75, GitHub #298). Reporting it lets the release key the retained continuation to where the work
// really is. The parent checkout proves nothing, so only a linked checkout is reported.
function recordReleaseCheckout(input: HookInput, agentId: string, checkoutRoot: string): void {
  if (stringField(input, 'tool_name') !== 'mcp__plugin_sidequest_board__release' || !isRecord(input.tool_input)) return;
  const toolInput = input.tool_input;
  const ref = String(toolInput.ref || '').trim();
  const by = String(toolInput.by || '').trim();
  if (!ref || !by) return;
  try {
    const store = require(runtimeModule('store')) as {
      findProject: (project: string) => { ok?: boolean; slug?: string };
      sessionProjectRoot: () => string;
      recordReleaseObservedCheckout: (slug: string, ref: string, options: unknown) => unknown;
    };
    const found = store.findProject(String(toolInput.project || '').trim() || store.sessionProjectRoot());
    if (found.ok && found.slug) store.recordReleaseObservedCheckout(found.slug, ref, { by, agentId, observedWorktree: checkoutRoot });
  } catch (_) {
  }
}

function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (bindClaimRuntimeIdentity(input, agentId, executor)) return;
  if (!agentId || !executorAgent(executor)) return;

  const cwd = stringField(input, 'cwd');
  if (!cwd) return;
  const checkout = enclosingCheckout(cwd);
  if (!checkout?.linked) return;
  recordReleaseCheckout(input, agentId, checkout.root);

  const found = isolationExpectation(input, agentId, executor, true, checkout.root);
  if (found?.terminal || found?.identityBound) return;
  bindObservedRuntimeIdentity(input, agentId, executor, checkout.root);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
