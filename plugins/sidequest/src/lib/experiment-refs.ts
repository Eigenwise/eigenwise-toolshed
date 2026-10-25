import { execFileSync, spawnSync } from 'node:child_process';

export function experimentRoundRef(ref: string, round: number | string): string {
  return `refs/sidequest-rounds/${ref}/r${round}`;
}

export function resolveExperimentRoundRef(project: string, ref: string, round: number): string {
  const target = experimentRoundRef(ref, round);
  const current = spawnSync('git', ['show-ref', '--verify', '--quiet', target], { cwd: project, windowsHide: true });
  if (current.status === 0) return target;
  const legacy = `refs/sidequest/${ref}/r${round}`;
  const previous = spawnSync('git', ['show-ref', '--verify', '--quiet', legacy], { cwd: project, windowsHide: true });
  return previous.status === 0 ? legacy : target;
}

function migrateExperimentRound(project: string, name: string, commit: string, ref: string): void {
  const round = name.slice(`refs/sidequest/${ref}/r`.length);
  const target = experimentRoundRef(ref, round);
  const existing = spawnSync('git', ['show-ref', '--verify', '--hash', target], { cwd: project, encoding: 'utf8', windowsHide: true });
  if (existing.status === 0 && existing.stdout.trim() !== commit) {
    throw new Error(`Cannot migrate ${name}: ${target} already pins a different commit.`);
  }
  const preserve = existing.status === 0 ? `verify ${target} ${commit}` : `create ${target} ${commit}`;
  execFileSync('git', ['update-ref', '--stdin'], {
    cwd: project, encoding: 'utf8', windowsHide: true,
    input: `start\n${preserve}\ndelete ${name} ${commit}\nprepare\ncommit\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function migrateExperimentRoundRefs(project: string, ref: string): void {
  const repository = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: project, windowsHide: true });
  if (repository.status !== 0) return;
  const prefix = `refs/sidequest/${ref}/`;
  const output = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', prefix], {
    cwd: project, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const line of output.trim().split('\n')) {
    const [name = '', commit = ''] = line.trim().split(' ');
    if (/^r[1-9]\d*$/.test(name.slice(prefix.length))) migrateExperimentRound(project, name, commit, ref);
  }
}
