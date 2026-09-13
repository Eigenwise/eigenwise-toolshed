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
    // One path's exact entry in a commit's tree: object id plus mode and type, which is what makes
    // two trees the same content rather than merely similar history. `null` means the path is really
    // absent there. `undefined` means the tree could not answer, and a caller proving provenance must
    // treat that as disagreement rather than as an empty answer.
    treeEntry: (rev, file) => {
      const result = invoke(['ls-tree', '-z', '--full-tree', rev, '--', file], { allowFail: true });
      if (result.code !== 0) return undefined;
      const records = result.stdout.split('\0').filter(Boolean);
      if (records.length === 0) return null;
      if (records.length > 1) return undefined;
      const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,})\t(.*)$/.exec(records[0]);
      if (!match || match[4] !== file) return undefined;
      return { mode: match[1], type: match[2], object: match[3] };
    },
    localTags: () => capture(['tag', '--list']).split('\n').map((line) => line.trim()).filter(Boolean),
    remoteTags: (remote) =>
      capture(['ls-remote', '--tags', remote])
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
        .filter(Boolean),
    remoteBranchHead: (remote, branch) => {
      const ref = `refs/heads/${branch}`;
      const output = capture(['ls-remote', '--exit-code', remote, ref]);
      const [commit, foundRef] = output.split(/\s+/);
      if (!commit || foundRef !== ref) throw new Error(`remote ${remote} has no ${ref}`);
      return commit;
    },
    remoteUrl: (remote) => capture(['remote', 'get-url', remote]),
    // An annotated tag's plain ls-remote line is the tag object; the "^{}" line is the commit it
    // points at, which is the only thing worth comparing a release sha against.
    remoteTagTargets: (remote) => {
      const targets = new Map();
      for (const line of capture(['ls-remote', '--tags', remote]).split('\n')) {
        const [sha, ref] = line.split('\t');
        if (!sha || !ref) continue;
        const name = ref.replace(/^refs\/tags\//, '');
        if (name.endsWith('^{}')) targets.set(name.slice(0, -3), sha);
        else if (!targets.has(name)) targets.set(name, sha);
      }
      return targets;
    },

    stagedFiles: () => capture(['diff', '--cached', '--name-only']).split('\n').map((line) => line.trim()).filter(Boolean),
    tagTarget: (tag) => {
      const result = invoke(['rev-list', '-n', '1', `refs/tags/${tag}`], { allowFail: true });
      return result.code === 0 ? result.stdout.trim() : null;
    },

    branchExists: (name) => invoke(['rev-parse', '--verify', `refs/heads/${name}`], { allowFail: true }).code === 0,
    switchNewBranch: (name, rev) => invoke(['checkout', '-q', '-b', name, rev], { skipOnDryRun: true }),
    switchBranch: (name) => invoke(['checkout', '-q', name], { skipOnDryRun: true }),
    deleteBranch: (name) => invoke(['branch', '-q', '-D', name], { skipOnDryRun: true }),

    mergeFastForward: (rev) => invoke(['merge', '--ff-only', rev], { skipOnDryRun: true }),
    cherryPick: (rev) => invoke(['cherry-pick', '-x', rev], { skipOnDryRun: true }),
    add: (paths) => invoke(['add', '--', ...paths], { skipOnDryRun: true }),
    commit: (message) => invoke(['commit', '-m', message], { skipOnDryRun: true }),
    // The target is required. An implicit HEAD published a tag at whatever the checkout happened to
    // be on instead of the validated commit (SQ-2826), and every caller already knows that sha.
    tag: (name, message, target) => {
      if (!target) throw new Error(`refusing to create tag ${name} without an explicit target commit`);
      return invoke(['tag', '-a', name, '-m', message, target], { skipOnDryRun: true });
    },
    resetHard: (rev) => invoke(['reset', '--hard', rev], { skipOnDryRun: true }),
    deleteTag: (name) => invoke(['update-ref', '-d', `refs/tags/${name}`], { skipOnDryRun: true }),
    pushAtomic: (remote, refspecs) => invoke(['push', '--atomic', remote, ...refspecs], { skipOnDryRun: true }),
  };
}
