import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveInRepo } from './paths.mjs';

// Every input a plan is built from has to come from one place. Mixing a pinned commit with the
// checkout is how a dry run ends up describing a different release than the cut that follows it.

export function diskSource(repoRoot) {
  return {
    label: 'the working tree',
    pinned: false,
    read(relative, label) {
      const absolute = resolveInRepo(repoRoot, relative, label ?? relative);
      return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
    },
    list(directory) {
      const absolute = resolveInRepo(repoRoot, directory);
      if (!existsSync(absolute)) return [];
      return readdirSync(absolute)
        .map((name) => path.posix.join(directory, name))
        .sort();
    },
  };
}

export function commitSource(git, sha) {
  return {
    label: sha,
    pinned: true,
    sha,
    read(relative) {
      return git.showFile(sha, relative);
    },
    list(directory) {
      return git.listFiles(sha, directory).sort();
    },
  };
}
