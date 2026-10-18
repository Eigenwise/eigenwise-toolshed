// `claude plugin test` sweeps every *.test.ts under the folder it is given, and this plugin's node:test
// suites cannot load as module tests. So the guards module runs from a copy holding only what it imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-guards-module-'));
try {
  for (const file of ['hooks/guards', 'src/lib/denied-tools.ts', 'src/lib/exec-names.ts', 'src/hooks/shared/shell-writes.ts', 'src/hooks/shared/main-thread-mutations.ts','types/index.d.ts']) {
    fs.cpSync(path.join(pluginRoot, file), path.join(copy, file), { recursive: true });
  }
  fs.mkdirSync(path.join(copy, '.claude-plugin'));
  fs.writeFileSync(path.join(copy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sidequest', version: '0.0.0', description: 'sidequest guards module test copy' }));
  fs.writeFileSync(path.join(copy, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./guards/register.ts'] }));
  const windows = process.platform === 'win32';
  const result = spawnSync('claude', ['plugin', 'test', windows ? `"${copy}"` : copy], { stdio: 'inherit', shell: windows });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}
