import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stubGithub(testContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'github-sync-stub-'));
  const preload = path.join(directory, 'preload.cjs');
  const log = path.join(directory, 'calls.jsonl');
  fs.linkSync(process.execPath, path.join(directory, process.platform === 'win32' ? 'gh.exe' : 'gh'));
  fs.writeFileSync(preload, `if (/gh(?:\\.exe)?$/.test(process.execPath)) {
    require('node:fs').appendFileSync(process.env.GH_SYNC_LOG, JSON.stringify([require('node:path').basename(process.argv[1]), ...process.argv.slice(2)]) + '\\n');
    if (process.env.GH_SYNC_FAIL) { process.stderr.write('authentication required'); process.exit(1); }
    process.exit(0);
  }`);
  const environment = { ...process.env };
  process.env.PATH = directory + path.delimiter + process.env.PATH;
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '') + ' --require=' + JSON.stringify(preload.replaceAll('\\', '/'));
  process.env.GH_SYNC_LOG = log;
  testContext.after(() => { process.env = environment; fs.rmSync(directory, { recursive: true, force: true }); });
  return { calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}
