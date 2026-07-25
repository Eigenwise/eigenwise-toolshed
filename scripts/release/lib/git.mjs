import { spawnSync } from 'node:child_process';

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout || '').trim()}`);
    this.args = args;
    this.result = result;
  }
}

export function spawnRunner(cwd) {
  return (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

/** The only git verb that can change a remote. Everything else is local or read-only. */
export function mutatesRemote(args) {
  return args[0] === 'push';
}

export function createGit({ cwd, run = spawnRunner(cwd), dryRun = false, onCommand = null } = {}) {
  const history = [];

  const invoke = (args, { allowFail = false, skipOnDryRun = false } = {}) => {
    const entry = { args: [...args], mutatesRemote: mutatesRemote(args), skipped: false };
    if (dryRun && skipOnDryRun) {
      entry.skipped = true;
      history.push(entry);
      onCommand?.(entry);
      return { code: 0, stdout: '', stderr: '', skipped: true };
    }
    history.push(entry);
    onCommand?.(entry);
    const result = run(args);
    entry.code = result.code;
    if (result.code !== 0 && !allowFail) throw new GitError(args, result);
    return result;
  };

  const capture = (args) => invoke(args).stdout.trim();

  return {
    cwd,
    history,
    dryRun,
    invoke,
    capture,

    revParse: (rev) => capture(['rev-parse', '--verify', `${rev}^{commit}`]),
    currentBranch: () => capture(['rev-parse', '--abbrev-ref', 'HEAD']),
    isClean: () => capture(['status', '--porcelain']) === '',
    commitDate: (rev) => capture(['show', '-s', '--format=%cs', rev]),
    showFile: (rev, file) => {
      const result = invoke(['show', `${rev}:${file}`], { allowFail: true });
      return result.code === 0 ? result.stdout : null;
    },
    listFiles: (rev, directory) => {
      const result = invoke(['ls-tree', '--name-only', rev, `${directory}/`], { allowFail: true });
      return result.code === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    },
    isAncestor: (ancestor, descendant) => invoke(['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }).code === 0,
    localTags: () => capture(['tag', '--list']).split('\n').map((line) => line.trim()).filter(Boolean),
    remoteTags: (remote) =>
      capture(['ls-remote', '--tags', remote])
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
        .filter(Boolean),

    mergeFastForward: (rev) => invoke(['merge', '--ff-only', rev], { skipOnDryRun: true }),
    cherryPick: (rev) => invoke(['cherry-pick', '-x', rev], { skipOnDryRun: true }),
    add: (paths) => invoke(['add', '--', ...paths], { skipOnDryRun: true }),
    commit: (message) => invoke(['commit', '-m', message], { skipOnDryRun: true }),
    tag: (name, message) => invoke(['tag', '-a', name, '-m', message], { skipOnDryRun: true }),
    pushAtomic: (remote, refspecs) => invoke(['push', '--atomic', remote, ...refspecs], { skipOnDryRun: true }),
  };
}
