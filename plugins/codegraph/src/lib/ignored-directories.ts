import { access } from 'node:fs/promises';
import path from 'node:path';

// Freshness walks every directory under the project root on every status and
// every query, so a directory nothing can extract source from is pure latency.
// The TypeScript contributor skipped only .git and node_modules, which meant a
// Python repository re-walked its whole virtualenv on each call and a single
// codegraph_context could sit for minutes. Names alone are not enough: a
// virtualenv can be called anything, and pyvenv.cfg is what actually marks one.
const alwaysIgnoredNames: ReadonlySet<string> = new Set([
  '.eggs', '.git', '.mypy_cache', '.nox', '.pytest_cache', '.ruff_cache', '.tox',
  '__pycache__', 'node_modules',
]);

export async function isIgnoredDirectory(directory: string, additionalNames: ReadonlySet<string> = new Set()): Promise<boolean> {
  const name = path.basename(directory);
  if (alwaysIgnoredNames.has(name) || additionalNames.has(name)) return true;
  try {
    await access(path.join(directory, 'pyvenv.cfg'));
    return true;
  } catch {
    return false;
  }
}
