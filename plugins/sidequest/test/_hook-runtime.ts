import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const REPOSITORY_PLUGIN_ROOT = fs.realpathSync(path.join(__dirname, '..'));

process.env.CLAUDE_PLUGIN_ROOT = REPOSITORY_PLUGIN_ROOT;

export function assertRepositoryHookRuntime(): void {
  assert.equal(
    fs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT ?? ''),
    REPOSITORY_PLUGIN_ROOT,
    'hook subprocesses must resolve their runtime from this repository',
  );
}
