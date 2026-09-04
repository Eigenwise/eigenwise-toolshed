export const WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS = 120;
export const WORKTREE_CREATE_SETUP_HEADROOM_MS = 10_000;

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function worktreeCreateHookTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const injected = positiveInteger(environment.SIDEQUEST_WORKTREE_CREATE_HOOK_TIMEOUT_MS);
  return injected || WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS * 1_000;
}

export function worktreeSetupDeadlineMs(environment: NodeJS.ProcessEnv = process.env): number {
  const hookTimeoutMs = worktreeCreateHookTimeoutMs(environment);
  const headroomMs = Math.min(WORKTREE_CREATE_SETUP_HEADROOM_MS, Math.floor(hookTimeoutMs / 10));
  return Math.max(1, hookTimeoutMs - headroomMs);
}
