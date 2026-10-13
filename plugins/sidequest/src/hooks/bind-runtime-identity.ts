#!/usr/bin/env node
import { readStdin, stringField, isRecord, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { writeDeny, writeToolUpdate } from './shared/output.js';
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
      const binding = store.bindClaimRuntimeIdentity(found.slug, ref, {
        observedWorktree: observedLinkedCheckout(input),
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

// The harness confines an isolated executor to the linked checkout it created, so the call's cwd is the one fact that
// can settle a crossed creation-order lease (SQ-55). The parent checkout proves nothing, so only a linked one is named.
function observedLinkedCheckout(input: HookInput): string | null {
  const cwd = stringField(input, 'cwd');
  const checkout = cwd ? enclosingCheckout(cwd) : null;
  return checkout?.linked ? checkout.root : null;
}

type ReleaseCheckoutStore = {
  findProject(project: string): { ok?: boolean; slug?: string };
  sessionProjectRoot(): string;
  recordReleaseObservedCheckout(slug: string, ref: string, options: unknown): unknown;
};

function releaseToolInput(input: HookInput): HookInput | null {
  return stringField(input, 'tool_name') === 'mcp__plugin_sidequest_board__release' && isRecord(input.tool_input) ? input.tool_input : null;
}

function releaseCall(input: HookInput) {
  const toolInput = releaseToolInput(input);
  if (!toolInput) return null;
  const ref = stringField(toolInput, 'ref').trim();
  const by = stringField(toolInput, 'by').trim();
  return ref && by ? { ref, by, project: stringField(toolInput, 'project').trim() } : null;
}

// `project` is optional on release, as on claim, and the MCP handler resolves an omitted one the same way.
function releaseProjectSlug(store: ReleaseCheckoutStore, project: string): string | null {
  const found = store.findProject(project || store.sessionProjectRoot());
  return found.ok && found.slug ? found.slug : null;
}

// A crossed executor's release is made from the checkout the harness confined it to, which can differ from the one its
// ticket records (SQ-75, GitHub #298). Reporting it lets the release key the retained continuation to where the work
// really is.
function recordReleaseCheckout(input: HookInput, agentId: string, checkoutRoot: string): void {
  const release = releaseCall(input);
  if (!release) return;
  try {
    const store = require(runtimeModule('store')) as ReleaseCheckoutStore;
    const slug = releaseProjectSlug(store, release.project);
    if (slug) store.recordReleaseObservedCheckout(slug, release.ref, { by: release.by, agentId, observedWorktree: checkoutRoot });
  } catch (_) {
  }
}

function executorCheckoutRoot(input: HookInput, agentId: string, executor: string): string | null {
  return agentId && executorAgent(executor) ? observedLinkedCheckout(input) : null;
}

function rebindObservedCheckout(input: HookInput, agentId: string, executor: string, checkoutRoot: string): void {
  const found = isolationExpectation(input, agentId, executor, true, checkoutRoot);
  if (found?.terminal || found?.identityBound) return;
  bindObservedRuntimeIdentity(input, agentId, executor, checkoutRoot);
}

// The MCP server shares one runtime session id across every subagent, so it cannot tell an executor from the
// orchestrator. Only this hook sees agent_id, so a subagent that omits `by` on a tool the MCP server defaults
// (mcp.ts CONTROL_PLANE_DEFAULT_BY) is settled here: rework gets the owner label its own dispatch recorded, or a
// refusal naming the identities in conflict (GH-424); groomClose and supersede_submission have no attributable owner,
// so they are refused rather than closing a ticket as the main session. A main-thread call carries no agent_id and
// falls through to the MCP default, the session id.
const SUBAGENT_BY_TOOLS = new Set(['rework', 'groomClose', 'supersede_submission']);
const BOARD_TOOL_PREFIX = 'mcp__plugin_sidequest_board__';

function boardToolName(input: HookInput): string {
  const toolName = stringField(input, 'tool_name');
  return toolName.startsWith(BOARD_TOOL_PREFIX) ? toolName.slice(BOARD_TOOL_PREFIX.length) : '';
}

function omitsBy(toolInput: Record<string, unknown>): boolean {
  return !String(toolInput.by ?? '').trim();
}

function subagentCallWithoutBy(input: HookInput, agentId: string): { tool: string; toolInput: Record<string, unknown> } | null {
  const tool = boardToolName(input);
  const toolInput = input.tool_input;
  if (!agentId || !SUBAGENT_BY_TOOLS.has(tool) || !isRecord(toolInput) || !omitsBy(toolInput)) return null;
  return { tool, toolInput };
}

function refuseSubagentBy(tool: string, agentId: string): void {
  writeDeny('PreToolUse', `sidequest: ${tool} omitted by and cannot default it: subagent ${agentId} would act as the main session id, a different identity. Pass by = your own claim id, or leave ${tool} to the orchestrator.`);
}

function defaultSubagentBy(input: HookInput, agentId: string): boolean {
  const call = subagentCallWithoutBy(input, agentId);
  if (!call) return false;
  if (call.tool === 'rework') defaultReworkBy(call.toolInput, agentId);
  else refuseSubagentBy(call.tool, agentId);
  return true;
}

function defaultReworkBy(toolInput: Record<string, unknown>, agentId: string): void {
  const store = require(runtimeModule('store')) as {
    dispatchCallerOwners: (identity: unknown) => Array<{ ref: string; by: string }>;
  };
  const owners = store.dispatchCallerOwners({ agentId, ref: toolInput.ref });
  const labels = Array.from(new Set(owners.map((owner) => owner.by)));
  if (labels.length === 1) return writeToolUpdate({ ...toolInput, by: labels[0] });
  const named = labels.length ? `owner labels ${labels.map((label) => `"${label}"`).join(' and ')}` : 'no dispatch with an owner label';
  writeDeny('PreToolUse', `sidequest: rework omitted by and cannot default it: subagent ${agentId} has ${named}, while the main session id is a different identity. Pass by = the submitter's claim id.`);
}

function main(): void {
  const input = readStdin();
  if (!input) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (defaultSubagentBy(input, agentId)) return;
  if (bindClaimRuntimeIdentity(input, agentId, executor)) return;
  const checkoutRoot = executorCheckoutRoot(input, agentId, executor);
  if (!checkoutRoot) return;
  recordReleaseCheckout(input, agentId, checkoutRoot);
  rebindObservedCheckout(input, agentId, executor, checkoutRoot);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
