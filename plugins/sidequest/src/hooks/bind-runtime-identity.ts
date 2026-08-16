#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
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
function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;

  const cwd = stringField(input, 'cwd');
  if (!cwd) return;
  const checkout = enclosingCheckout(cwd);
  if (!checkout?.linked) return;

  const found = isolationExpectation(input, agentId, executor);
  if (found?.terminal || found?.identityBound) return;
  bindObservedRuntimeIdentity(input, agentId, executor, checkout.root);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
