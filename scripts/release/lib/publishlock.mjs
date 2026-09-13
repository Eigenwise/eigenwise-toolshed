import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquirePublishLock, releasePublishLock } = require('../../../plugins/sidequest/lib/publish.js');

function releaseLockOwner() {
  return process.env.SIDEQUEST_AGENT
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || `release-cut-${process.pid}`;
}

function releaseSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.SIDEQUEST_SESSION || null;
}

export function createPublishLock(repoRoot) {
  const options = { by: releaseLockOwner(), sessionId: releaseSessionId() };
  return {
    acquire: () => acquirePublishLock(repoRoot, options),
    release: () => releasePublishLock(repoRoot, options),
  };
}

export function publishLockRefusal(result) {
  const holder = result.holder ?? {};
  const owner = holder.by || holder.sessionId || 'another publisher';
  return `publish lock is held by "${owner}". Wait for it to release, or use sidequest publish lock --steal only after confirming the holder is dead.`;
}

export function publishLockReleaseFailure(result) {
  const holder = result?.holder ?? {};
  const owner = holder.by || holder.sessionId || 'another publisher';
  return `could not release the publish lock owned by "${owner}". Release it with sidequest publish unlock after confirming the published refs.`;
}
