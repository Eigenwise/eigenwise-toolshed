import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectStateDirectory } from '../src/lib/paths.ts';

test('SessionStart hook emits a bounded metadata-only pointer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codegraph-hook-'));
  try {
    const stateRoot = path.join(root, 'state');
    const stateDirectory = projectStateDirectory(root, { CODEGRAPH_STATE_DIR: stateRoot });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, 'status.json'), JSON.stringify({ status: 'stale', snapshotId: '1234567890abcdef' }));
    const hook = path.resolve(process.cwd(), 'hooks', 'session-start.js');
    const child = spawnSync(process.execPath, [hook], { env: { ...process.env, CODEGRAPH_STATE_DIR: stateRoot }, input: JSON.stringify({ cwd: root }), encoding: 'utf8' });
    assert.equal(child.status, 0);
    assert.ok(Buffer.byteLength(child.stdout, 'utf8') <= 1_024);
    const output = JSON.parse(child.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(output.hookSpecificOutput.additionalContext, /Codegraph: stale/);
    assert.match(output.hookSpecificOutput.additionalContext, /codegraph_status/);

    await writeFile(path.join(stateDirectory, 'status.json'), JSON.stringify({
      status: 'error',
      failure: { reason: 'simulated refresh failure', failedAt: '2026-08-10T00:00:00.000Z' },
    }));
    const failedHook = spawnSync(process.execPath, [hook], { env: { ...process.env, CODEGRAPH_STATE_DIR: stateRoot }, input: JSON.stringify({ cwd: root }), encoding: 'utf8' });
    assert.equal(failedHook.status, 0);
    const failedOutput = JSON.parse(failedHook.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(failedOutput.hookSpecificOutput.additionalContext, /Codegraph: error/);
    assert.match(failedOutput.hookSpecificOutput.additionalContext, /last index failed: simulated refresh failure/);

    await writeFile(path.join(stateDirectory, 'status.json'), '{');
    const malformedHook = spawnSync(process.execPath, [hook], { env: { ...process.env, CODEGRAPH_STATE_DIR: stateRoot }, input: JSON.stringify({ cwd: root }), encoding: 'utf8' });
    assert.equal(malformedHook.status, 0);
    const malformedOutput = JSON.parse(malformedHook.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(malformedOutput.hookSpecificOutput.additionalContext, /Codegraph: error/);
    assert.match(malformedOutput.hookSpecificOutput.additionalContext, /status metadata is malformed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
