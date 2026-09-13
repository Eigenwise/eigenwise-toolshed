/**
 * The commands that carry a prepared release across a protected branch. The engine prints them and
 * never runs them: a protected branch moves only through a reviewed PR, so a release that cannot
 * open or merge one has to stop with instructions rather than fall back to pushing the branch.
 */
export function promotionCommands({ remote = 'origin', releaseBranch, publishBranch = 'main', tag, pushed = false }) {
  const commands = [];
  if (!pushed) commands.push(`git push ${remote} refs/heads/${releaseBranch}:refs/heads/${releaseBranch}`);
  commands.push(
    `gh pr create --base ${publishBranch} --head ${releaseBranch} --title "release ${tag}" ` +
    `--body "Promotes ${tag} to ${publishBranch}. Tag it with node scripts/release/finalize.mjs --push after the required checks pass and this PR merges."`,
  );
  commands.push('gh pr merge --merge   # after the required checks pass');
  commands.push(`node scripts/release/finalize.mjs --push   # tags the merged ${publishBranch} commit`);
  return commands;
}

/**
 * Bringing the release commit back to the integration branch is itself a PR: both branches are
 * protected, so nothing here resets or rewrites either one.
 */
export function developSyncCommands({ remote = 'origin', publishBranch = 'main', baseBranch = 'develop', tag }) {
  const branch = `sync/${publishBranch}-to-${baseBranch}-${tag}`;
  return [
    `git fetch ${remote} ${publishBranch} ${baseBranch}`,
    `git switch -c ${branch} ${remote}/${baseBranch}`,
    `git merge --no-ff ${remote}/${publishBranch}`,
    `git push ${remote} refs/heads/${branch}:refs/heads/${branch}`,
    `gh pr create --base ${baseBranch} --head ${branch} --title "sync ${tag} into ${baseBranch}" --fill`,
  ];
}
