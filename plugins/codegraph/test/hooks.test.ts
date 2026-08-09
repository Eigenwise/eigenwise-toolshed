import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('SessionStart hook emits a bounded metadata-only pointer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codegraph-hook-'));
  try {
    const stateDirectory = path.join(root, '.claude', 'codegraph');
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, 'status.json'), JSON.stringify({ status: 'stale', snapshotId: '1234567890abcdef' }));
    const hook = path.resolve(process.cwd(), 'hooks', 'session-start.js');
    const child = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: root }), encoding: 'utf8' });
    assert.equal(child.status, 0);
    assert.ok(Buffer.byteLength(child.stdout, 'utf8') <= 1_024);
    const output = JSON.parse(child.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(output.hookSpecificOutput.additionalContext, /Codegraph: stale/);
    assert.match(output.hookSpecificOutput.additionalContext, /codegraph_status/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
