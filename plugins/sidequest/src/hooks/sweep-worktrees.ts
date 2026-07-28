#!/usr/bin/env node
// Detached worker for the SessionStart worktree sweep. It is spawned by
// session-start rather than run inline so a slow sweep cannot consume the hook's
// timeout and take the injected context down with it.
import { sweepWorktrees } from './shared/worktree-sweep.js';
import { writeReport } from './shared/sweep-handoff.js';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function main(): Promise<void> {
  const cwd = argument('cwd') || process.cwd();
  const data = { cwd, session_id: argument('session') };
  let notices: string[];
  try {
    notices = await sweepWorktrees(data, true);
  } catch (error: any) {
    notices = [`sidequest: worktree sweep failed: ${(error && error.message) || error}`];
  }
  writeReport(cwd, notices);
}

main().catch((error) => {
  writeReport(argument('cwd') || process.cwd(), [
    `sidequest: worktree sweep failed: ${(error && error.message) || error}`,
  ]);
});
