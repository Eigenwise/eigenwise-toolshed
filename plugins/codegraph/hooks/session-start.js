'use strict';
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const maximumContextBytes = 1024;
const allowedStatuses = new Set(['ready', 'missing', 'stale', 'unavailable']);
function pointer(status, snapshotId) { return `Codegraph: ${status}${snapshotId === undefined ? '' : ` (${snapshotId.slice(0, 12)})`}. Use codegraph_status for details and codegraph_index to refresh.`; }
async function readHookInput() { const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; } }
async function statusPointer(root) {
  try {
    const value = JSON.parse(await readFile(path.join(root, '.claude', 'codegraph', 'status.json'), 'utf8'));
    if (typeof value.status === 'string' && allowedStatuses.has(value.status)) return pointer(value.status, typeof value.snapshotId === 'string' ? value.snapshotId : undefined);
  } catch {}
  return pointer('missing');
}
async function main() { const input = await readHookInput(); const root = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd(); const additionalContext = (await statusPointer(root)).slice(0, maximumContextBytes); process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`); }
void main();
