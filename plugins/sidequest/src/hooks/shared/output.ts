import crypto from 'node:crypto';

const CONTEXT_BUDGETS: Record<string, number> = Object.freeze({
  SessionStart: 4 * 1024,
  UserPromptSubmit: 1024,
  PreToolUse: 768,
  PreCompact: 1500,
  PostCompact: 1500,
  SubagentStart: 512,
  SubagentStop: 512,
  Stop: 512,
  PostToolUseFailure: 512,
  TeammateIdle: 512,
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function contextBudget(hookEventName: string): number {
  return CONTEXT_BUDGETS[hookEventName] || 512;
}

function stableWatermark(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    truncated += character;
    bytes += characterBytes;
  }
  return truncated;
}

function projectedText(hookEventName: string, value: string): string {
  const budget = contextBudget(hookEventName);
  if (byteLength(value) <= budget) return value;
  const watermark = stableWatermark(value);
  const omission = `\n[sidequest context v1 id=${hookEventName} revision=${watermark} watermark=${watermark}; content omitted for ${budget}B budget. Retrieve current board state with mcp__plugin_sidequest_board__comments({ref:"<ticket-ref>"}).]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(omission)))}${omission}`;
}

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

export function writeContext(hookEventName: string, additionalContext: string, initialUserMessage = ''): void {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: projectedText(hookEventName, additionalContext),
      ...(initialUserMessage ? { initialUserMessage } : {}),
    },
  });
}

export function writeDeny(hookEventName: string, permissionDecisionReason: string): void {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      permissionDecisionReason: projectedText(hookEventName, permissionDecisionReason),
    },
  });
}

// The model never reads systemMessage: Claude Code 2.1.233's attachment-to-model table maps
// hook_system_message to nothing, and its own schema describes the field as "Warning message shown to the
// user". Guidance meant to steer the MODEL has to ride hookSpecificOutput.additionalContext, which lands in
// the conversation as an isMeta message (SQ-2213). Stop is deliberately absent from this set: Stop
// additionalContext makes the conversation continue so the model can act on it, which would turn a
// stop-time suggestion into a loop of resumed turns.
const MODEL_VISIBLE_MIRROR_EVENTS = new Set(['PreToolUse', 'PostToolUseFailure']);

export function writeSystemMessage(hookEventName: string, systemMessage: string): void {
  const projected = projectedText(hookEventName, systemMessage);
  writeJson({
    systemMessage: projected,
    hookSpecificOutput: {
      hookEventName,
      ...(MODEL_VISIBLE_MIRROR_EVENTS.has(hookEventName) ? { additionalContext: projected } : {}),
    },
  });
}

export function writeToolUpdate(updatedInput: Record<string, unknown>, systemMessage?: string | null): void {
  const context = systemMessage ? projectedText('PreToolUse', systemMessage) : '';
  writeJson({
    ...(context ? { systemMessage: context } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
      ...(context ? { additionalContext: context } : {}),
    },
  });
}

export function writeTeammateStop(stopReason: string): void {
  writeJson({ continue: false, stopReason: projectedText('TeammateIdle', stopReason) });
}

export const HOOK_CONTEXT_BUDGETS = CONTEXT_BUDGETS;
