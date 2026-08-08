#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 600;

function parsePositiveSeconds(value, option) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`${option} requires a positive whole number of seconds`);
  return seconds;
}

function parseArgs(argv) {
  const options = {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    sha: 'HEAD',
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  let shaProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--timeout') {
      options.timeoutSeconds = parsePositiveSeconds(argv[index + 1], '--timeout');
      index += 1;
    } else if (argument === '--interval') {
      options.intervalSeconds = parsePositiveSeconds(argv[index + 1], '--interval');
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (shaProvided) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      options.sha = argument;
      shaProvided = true;
    }
  }

  return options;
}

function usage() {
  return `Usage: node check-ci.js [sha] [--timeout <seconds>] [--interval <seconds>]

Waits for every GitHub Actions workflow run on a commit to finish.

  sha                  Commit SHA to check (default: HEAD)
  --timeout <seconds>  Stop waiting after this many seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --interval <seconds> Poll every this many seconds (default: ${DEFAULT_INTERVAL_SECONDS})`;
}

function defaultRun(command) {
  const result = childProcess.spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return {
    error: result.error,
    ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
  };
}

function commandOutput(result) {
  return String(result?.output ?? [result?.stdout, result?.stderr].filter(Boolean).join('')).trim();
}

function commandSucceeded(result) {
  return result?.ok ?? (result?.status === 0 && !result?.error);
}

function runCommand(command, run) {
  const result = run(command);
  return { ...result, ok: commandSucceeded(result), output: commandOutput(result) };
}

function resolveSha(sha, run) {
  const result = runCommand({ command: 'git', args: ['rev-parse', '--verify', sha] }, run);
  if (!result.ok) throw new Error(`could not resolve ${sha} to a commit SHA${result.output ? `: ${result.output}` : ''}`);
  return result.output.split(/\s+/)[0];
}

function verifyGitHubAccess(run) {
  const authentication = runCommand({ command: 'gh', args: ['auth', 'status'] }, run);
  if (!authentication.ok) {
    if (authentication.error?.code === 'ENOENT') throw new Error('gh is not installed or is unavailable on PATH');
    throw new Error('gh is not authenticated. Run "gh auth login" and retry.');
  }

  const repository = runCommand({ command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner'] }, run);
  if (!repository.ok) {
    throw new Error('current repository does not have a GitHub remote. Add a GitHub remote and retry.');
  }
}

function workflowName(workflow) {
  return workflow.workflowName || workflow.name || `workflow run ${workflow.databaseId ?? 'unknown'}`;
}

function parseWorkflowRuns(output) {
  let workflows;
  try {
    workflows = JSON.parse(output);
  } catch {
    throw new Error('gh returned invalid workflow run data');
  }
  if (!Array.isArray(workflows)) throw new Error('gh returned workflow run data that was not a list');
  return workflows;
}

function listWorkflowRuns(sha, run) {
  const result = runCommand({
    command: 'gh',
    args: ['run', 'list', '--commit', sha, '--limit', '100', '--json', 'databaseId,status,conclusion,workflowName,name,url'],
  }, run);
  if (!result.ok) throw new Error(`could not list workflow runs for ${sha}${result.output ? `: ${result.output}` : ''}`);
  return parseWorkflowRuns(result.output);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsedSeconds(startedAt, now) {
  return Math.floor((now() - startedAt) / 1000);
}

function timeoutMessage(sha, seconds) {
  return `timed out waiting for workflow runs for ${sha} after ${seconds}s`;
}

async function checkCi({ options = {}, now = Date.now, report = console.log, run = defaultRun, wait = sleep } = {}) {
  const settings = {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    sha: 'HEAD',
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    ...options,
  };
  verifyGitHubAccess(run);
  const sha = resolveSha(settings.sha, run);
  const startedAt = now();
  let attempts = 0;
  let observedRuns = false;

  while (true) {
    attempts += 1;
    const workflows = listWorkflowRuns(sha, run);
    const elapsed = elapsedSeconds(startedAt, now);

    if (workflows.length > 0) {
      observedRuns = true;
      const incomplete = workflows.filter((workflow) => workflow.status !== 'completed');
      if (incomplete.length === 0) {
        const failed = workflows.filter((workflow) => workflow.conclusion !== 'success');
        if (failed.length > 0) {
          report(`CI failed for ${sha}:`);
          for (const workflow of failed) report(`- ${workflowName(workflow)} (${workflow.conclusion ?? 'no conclusion'}): ${workflow.url ?? 'no URL'}`);
          return { ok: false, sha };
        }
        report(`CI passed for ${sha}: ${workflows.map(workflowName).join(', ')}`);
        return { ok: true, sha };
      }
      report(`waiting (${attempts}): ${incomplete.map(workflowName).join(', ')}`);
    } else {
      report(`waiting (${attempts}): no workflow runs found yet`);
    }

    if (elapsed >= settings.timeoutSeconds) {
      if (!observedRuns) {
        report(`no workflow runs found for ${sha} after ${elapsed}s`);
      } else {
        report(`${timeoutMessage(sha, elapsed)} (bound: ${settings.timeoutSeconds}s)`);
      }
      return { ok: false, sha };
    }

    const remainingSeconds = settings.timeoutSeconds - elapsed;
    await wait(Math.min(settings.intervalSeconds, remainingSeconds) * 1000);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await checkCi({ options });
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`check-ci: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  checkCi,
  listWorkflowRuns,
  parseArgs,
  parseWorkflowRuns,
  timeoutMessage,
  usage,
  verifyGitHubAccess,
  workflowName,
};
