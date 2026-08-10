import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectStateDirectory } from '../lib/paths.js';

const maximumContextBytes = 1_024;
const allowedStatuses = new Set(['ready', 'missing', 'stale', 'unavailable', 'error']);

interface HookInput { cwd?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function failureReason(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.reason !== 'string' || value.reason.length === 0) return undefined;
  return value.reason;
}

function pointer(status: string, snapshotId?: string, reason?: string): string {
  const detail = status === 'error'
    ? reason === undefined ? '' : ` (last index failed: ${reason})`
    : snapshotId === undefined ? '' : ` (${snapshotId.slice(0, 12)})`;
  return `Codegraph: ${status}${detail}. Use codegraph_status for details and codegraph_index to refresh.`;
}

async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput; } catch { return {}; }
}

async function statusPointer(root: string): Promise<string> {
  try {
    const raw = await readFile(path.join(projectStateDirectory(root), 'status.json'), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.status !== 'string' || !allowedStatuses.has(value.status)) {
      return pointer('error', undefined, 'status metadata is malformed');
    }
    if (value.status === 'error') {
      const reason = failureReason(value.failure);
      return reason === undefined ? pointer('error', undefined, 'status metadata is malformed') : pointer('error', undefined, reason);
    }
    return pointer(value.status, typeof value.snapshotId === 'string' ? value.snapshotId : undefined);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return pointer('missing');
    return pointer('error', undefined, 'status metadata is malformed');
  }
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const root = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const additionalContext = (await statusPointer(root)).slice(0, maximumContextBytes);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
}

void main();
