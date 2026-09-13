import { spawnSync } from 'node:child_process';

const GITHUB_RELEASE_WORKFLOW = 'Publish GitHub Release';
const GITHUB_RELEASE_DEFERRED_MESSAGE = 'GitHub Release deferred by the daily cap; the scheduled publish will cover this tag.';
const GITHUB_RELEASE_POLL_INTERVAL_MS = 2_000;
const GITHUB_RELEASE_TIMEOUT_MS = 10 * 60 * 1_000;

export function isGitHubRemote(remoteUrl) {
  return /(?:^|[@/:])github\.com(?::|\/|$)/i.test(remoteUrl);
}

function quoteForSh(command) {
  return `'${command.replaceAll("'", "'\"'\"'")}'`;
}

export function containerTestCommand(commit, suites) {
  const suiteCommands = suites.map((suite) => {
    const commands = [suite.setup, suite.command].filter(Boolean).join('; ');
    return `(cd ${JSON.stringify(suite.cwd)}; ${commands})`;
  }).join('; ');
  const commands = `set -eu; mkdir repo; tar -x -C repo; cd repo; git init -q; git -c user.email=ci@local -c user.name=ci add -A; git -c user.email=ci@local -c user.name=ci commit -q -m baseline; ${suiteCommands}`;
  return `git archive ${commit} | docker run -i --rm node:22 sh -c ${quoteForSh(commands)}`;
}

/**
 * The aggregate Test run for one commit. `Test` fans out over a plugin/platform matrix whose job
 * names truncate and collide, so the workflow conclusion is the only stable answer to "did every
 * test job pass on this exact sha".
 */
export function assertParentCiPassed(repoRoot, commit, runner = spawnSync, suites = [], { overridable = true } = {}) {
  const retryHint = overridable
    ? ' Retry with --ci-override "<reason>" only when the release fixes that CI failure.'
    : ' Publication has no override: push a fix, let Test pass on the new publish-branch head, then finalize that commit.';
  const result = runner('gh', [
    'run', 'list', '--workflow', 'Test', '--commit', commit, '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot check Test workflow for ${commit}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`cannot check Test workflow for ${commit}${detail ? `: ${detail}` : ''}`);
  }
  let runs;
  try {
    runs = JSON.parse(result.stdout || '[]');
  } catch (_) {
    throw new Error(`cannot read Test workflow status for ${commit}: gh returned invalid JSON`);
  }
  const run = Array.isArray(runs) && runs.find((candidate) => candidate?.headSha === commit);
  if (!run) {
    throw new Error(
      `no completed Test workflow run found for ${commit}; refusing to publish.` +
      (overridable
        ? ` If Docker is available, run ${containerTestCommand(commit, suites)} before retrying with --ci-override "<reason>".`
        : ' Wait for Test to complete on that sha, then finalize again.'),
    );
  }
  if (run.conclusion !== 'success') {
    throw new Error(
      `Test workflow for ${commit} concluded ${run.conclusion || 'without a conclusion'}; refusing to publish.${retryHint}`,
    );
  }
  return { commit, conclusion: run.conclusion };
}

export async function assertGitHubReleasePublished(
  repoRoot,
  tag,
  commit,
  {
    runner = spawnSync,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    timeoutMs = GITHUB_RELEASE_TIMEOUT_MS,
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const release = runner('gh', ['release', 'view', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (release.error) throw new Error(`cannot check GitHub Release ${tag}: ${release.error.message}`);
    if (release.status === 0) return { tag, status: 'published' };

    const workflow = runner('gh', [
      'run', 'list', '--workflow', GITHUB_RELEASE_WORKFLOW, '--commit', commit,
      '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (workflow.error) throw new Error(`cannot check ${GITHUB_RELEASE_WORKFLOW} for ${tag}: ${workflow.error.message}`);
    if (workflow.status !== 0) {
      const detail = String(workflow.stderr || '').trim();
      throw new Error(`cannot check ${GITHUB_RELEASE_WORKFLOW} for ${tag}${detail ? `: ${detail}` : ''}`);
    }
    let runs;
    try {
      runs = JSON.parse(workflow.stdout || '[]');
    } catch (_) {
      throw new Error(`cannot read ${GITHUB_RELEASE_WORKFLOW} status for ${tag}: gh returned invalid JSON`);
    }
    const run = Array.isArray(runs) && runs.find((candidate) => candidate?.headSha === commit);
    if (run?.conclusion === 'success') {
      const completedRelease = runner('gh', ['release', 'view', tag], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (completedRelease.error) throw new Error(`cannot check GitHub Release ${tag}: ${completedRelease.error.message}`);
      if (completedRelease.status === 0) return { tag, status: 'published' };
      return { tag, status: 'deferred', message: GITHUB_RELEASE_DEFERRED_MESSAGE };
    }
    if (run?.conclusion) {
      throw new Error(`${GITHUB_RELEASE_WORKFLOW} for ${tag} concluded ${run.conclusion}; GitHub Release was not published`);
    }
    if (now() >= deadline) {
      throw new Error(`GitHub Release ${tag} was not found within ${Math.round(timeoutMs / 60_000)} minutes after publish`);
    }
    await sleep(GITHUB_RELEASE_POLL_INTERVAL_MS);
  }
}
