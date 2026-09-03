#!/usr/bin/env node
import { readStdin, stringField, isRecord, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
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
  if (!agentId || !sessionId || !executorAgent(executor) || !ref || String(toolInput.executor || '').trim() !== executor) return true;
  try {
    const store = require(runtimeModule('store')) as {
      findProject: (project: string) => { ok?: boolean; slug?: string };
      sessionProjectRoot: () => string;
      bindClaimRuntimeIdentity: (slug: string, ref: string, options: unknown) => unknown;
    };
    // `project` is optional on claim. The MCP claim handler resolves an omitted
    // project through store.sessionProjectRoot, so the bind must use the same
    // authority (not the tool call's cwd, which is a worktree or an unrelated
    // checkout) or the legal no-project claim binds nothing and every later
    // shared-tree write is refused as an unknown identity.
    const project = String(toolInput.project || '').trim() || store.sessionProjectRoot();
    const found = store.findProject(project);
    if (found.ok && found.slug) {
      store.bindClaimRuntimeIdentity(found.slug, ref, {
        token: toolInput.token,
        tokenFile: toolInput.tokenFile,
        executor,
        effort: toolInput.effort,
        agentId,
        sessionId,
      });
    }
  } catch (_) {
  }
  return true;
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

  const found = isolationExpectation(input, agentId, executor, true, checkout.root);
  if (found?.terminal || found?.identityBound) return;
  bindObservedRuntimeIdentity(input, agentId, executor, checkout.root);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
