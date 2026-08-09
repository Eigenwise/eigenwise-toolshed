import { readFile } from 'node:fs/promises';
import path from 'node:path';

const maximumContextBytes = 1_024;
const allowedStatuses = new Set(['ready', 'missing', 'stale', 'unavailable']);

interface HookInput { cwd?: unknown }
interface StatusPointer { status?: unknown; snapshotId?: unknown }

function pointer(status: string, snapshotId?: string): string {
  const detail = snapshotId === undefined ? '' : ` (${snapshotId.slice(0, 12)})`;
  return `Codegraph: ${status}${detail}. Use codegraph_status for details and codegraph_index to refresh.`;
}

async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput; } catch { return {}; }
}

async function statusPointer(root: string): Promise<string> {
  try {
    const raw = await readFile(path.join(root, '.claude', 'codegraph', 'status.json'), 'utf8');
    const value = JSON.parse(raw) as StatusPointer;
    if (typeof value.status === 'string' && allowedStatuses.has(value.status)) {
      return pointer(value.status, typeof value.snapshotId === 'string' ? value.snapshotId : undefined);
    }
  } catch { /* A missing metadata pointer is an expected first-run state. */ }
  return pointer('missing');
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const root = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const additionalContext = (await statusPointer(root)).slice(0, maximumContextBytes);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
}

void main();
