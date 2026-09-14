import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalPath, checkoutInstanceIdentity, createCheckoutInstanceMarker } from './kernel/worktree.js';

export interface IntegrationCheckout {
  path: string;
  gitDirectory: string;
  commonGitDirectory: string;
  checkoutInstance: string;
  startingRevision: string;
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 10_000 }).trim();
}

function gitPath(repository: string, flag: string): string {
  const value = git(repository, ['rev-parse', flag]);
  return canonicalPath(path.resolve(repository, value));
}

function checkoutFacts(repository: string, value: string, branch: string) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('integrationCheckout must be an absolute checkout path.');
  }
  const checkout = canonicalPath(value);
  if (!fs.statSync(checkout).isDirectory() || gitPath(checkout, '--show-toplevel') !== checkout) {
    throw new Error('integrationCheckout must name the checkout root.');
  }
  const gitDirectory = gitPath(checkout, '--git-dir');
  const commonGitDirectory = gitPath(checkout, '--git-common-dir');
  if (commonGitDirectory !== gitPath(repository, '--git-common-dir') || gitDirectory === commonGitDirectory) {
    throw new Error('integrationCheckout must be a linked checkout of the same repository, not its shared main checkout.');
  }
  const registered = git(repository, ['worktree', 'list', '--porcelain', '-z']).split('\0')
    .some((line) => line.startsWith('worktree ') && canonicalPath(line.slice(9)) === checkout);
  if (!registered) throw new Error('integrationCheckout is not a registered worktree.');
  if (git(checkout, ['branch', '--show-current']) !== branch) {
    throw new Error(`integrationCheckout must have branch ${branch} checked out.`);
  }
  return { path: checkout, gitDirectory, commonGitDirectory, startingRevision: git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']) };
}

export function captureIntegrationCheckout(repository: string, value: string, branch: string): IntegrationCheckout {
  try {
    const facts = checkoutFacts(repository, value, branch);
    if (git(facts.path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('integrationCheckout must be clean before dispatch.');
    let instance = checkoutInstanceIdentity(facts.gitDirectory);
    if (!instance) {
      try {
        instance = createCheckoutInstanceMarker(facts.gitDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        instance = checkoutInstanceIdentity(facts.gitDirectory);
      }
    }
    if (!instance) throw new Error('integrationCheckout has an unreadable checkout-instance marker.');
    return { ...facts, checkoutInstance: instance };
  } catch (error) {
    throw new Error(`integrationCheckout: ${(error as Error).message}`);
  }
}

export function integrationCheckoutKey(target: any): string | null {
  const checkout = target?.checkout;
  // Dispatches may observe different heads of the same checkout as delivery advances.
  return checkout ? JSON.stringify([checkout.path, checkout.gitDirectory, checkout.commonGitDirectory, checkout.checkoutInstance]) : null;
}

export function integrationCheckoutPath(repository: string, target: any): string {
  if (!target || !Object.hasOwn(target, 'checkout')) return repository;
  try {
    const pinned = target.checkout as IntegrationCheckout;
    if (!pinned || !['path', 'gitDirectory', 'commonGitDirectory', 'checkoutInstance', 'startingRevision']
      .every((key) => typeof (pinned as any)[key] === 'string' && (pinned as any)[key])) {
      throw new Error('pinned checkout identity is incomplete; no fallback is allowed.');
    }
    const actual = checkoutFacts(repository, pinned.path, target.branch);
    if (actual.path !== pinned.path || actual.gitDirectory !== pinned.gitDirectory || actual.commonGitDirectory !== pinned.commonGitDirectory
      || checkoutInstanceIdentity(actual.gitDirectory) !== pinned.checkoutInstance) {
      throw new Error('pinned checkout identity no longer matches; no fallback is allowed.');
    }
    git(actual.path, ['merge-base', '--is-ancestor', pinned.startingRevision, actual.startingRevision]);
    return actual.path;
  } catch (error) {
    throw new Error(`integrationCheckout: ${(error as Error).message}`);
  }
}
