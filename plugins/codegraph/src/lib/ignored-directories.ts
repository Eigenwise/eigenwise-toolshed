import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

// Freshness walks every directory under the project root on every status and
// every query, so a directory nothing can extract source from is pure latency.
// The TypeScript contributor skipped only .git and node_modules, which meant a
// Python repository re-walked its whole virtualenv on each call.
const alwaysIgnoredNames: ReadonlySet<string> = new Set([
  '.eggs', '.git', '.mypy_cache', '.nox', '.pytest_cache', '.ruff_cache', '.tox',
  '.worktrees', '__pycache__', 'node_modules', 'worktrees',
]);

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

// A nested checkout is a DIFFERENT tree that happens to sit inside this one: an
// agent worktree, a vendored clone, a submodule. Indexing it puts a second
// stale copy of every symbol in the graph, so answers get scored against code
// that is not the project. The `.git` entry a checkout carries (a directory for
// a clone, a file holding `gitdir:` for a worktree) catches these wherever they
// are named, which the `worktrees` name above cannot. Both are needed: a real
// repository at .claude/worktrees/agent-<id>/ carried no `.git` of its own,
// because what sat there was a copied subdirectory of the project rather than a
// checkout. Only subdirectories are ever tested, so the project's own root is
// never mistaken for one of these.
async function isNestedCheckout(directory: string): Promise<boolean> {
  return exists(path.join(directory, '.git'));
}

// A virtualenv is a resolution environment, never project source, and it can be
// named anything, so pyvenv.cfg is what actually identifies one.
async function isVirtualEnvironment(directory: string): Promise<boolean> {
  return exists(path.join(directory, 'pyvenv.cfg'));
}

export async function isIgnoredDirectory(directory: string, additionalNames: ReadonlySet<string> = new Set()): Promise<boolean> {
  const name = path.basename(directory);
  if (alwaysIgnoredNames.has(name) || additionalNames.has(name)) return true;
  const [nestedCheckout, virtualEnvironment] = await Promise.all([
    isNestedCheckout(directory),
    isVirtualEnvironment(directory),
  ]);
  return nestedCheckout || virtualEnvironment;
}

// Pyright decides the indexed file set itself, so freshness agreeing to skip a
// directory is not enough: the same policy has to reach its config as concrete
// paths. Returns the shallowest ignored directory on each branch, since
// anything below one is excluded with it.
export async function ignoredDirectoriesUnder(root: string, additionalNames: ReadonlySet<string> = new Set()): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const directory = path.join(root, entry.name);
      return await isIgnoredDirectory(directory, additionalNames)
        ? [directory]
        : ignoredDirectoriesUnder(directory, additionalNames);
    }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}
