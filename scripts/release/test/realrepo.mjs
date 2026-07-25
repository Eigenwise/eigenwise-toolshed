import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fragmentText, marketplaceJson } from './helpers.mjs';

/**
 * A real repository with a real `origin`, both on local disk. The atomicity and refspec claims are
 * about what git actually does with a push, which no recorder can answer.
 */
export function makeGitRepo({ plugins = { sidequest: '3.6.17', workbench: '0.63.6' }, marketplaceVersion = '3.207.0', changelog = null } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'release-real-'));
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'work');
  mkdirSync(root, { recursive: true });

  const runIn = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      const error = new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
      error.stderr = result.stderr;
      throw error;
    }
    return result.stdout.trim();
  };

  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8', windowsHide: true });
  const git = (...args) => runIn(root, args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'release-test@example.com');
  git('config', 'user.name', 'release test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('remote', 'add', 'origin', origin);

  const write = (relative, contents) => {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };

  write('.claude-plugin/marketplace.json', marketplaceJson({ version: marketplaceVersion, plugins }));
  for (const [name, version] of Object.entries(plugins)) {
    write(`plugins/${name}/.claude-plugin/plugin.json`, `${JSON.stringify({ name, version, license: 'MIT' }, null, 2)}\n`);
    write(`plugins/${name}/index.js`, `// ${name}\n`);
    // A resolvable suite, so tests that hand cut() a runSuite actually see it called.
    write(`plugins/${name}/test/smoke.test.js`, "import test from 'node:test';\ntest('ok', () => {});\n");
  }
  write('.release/unreleased/.gitkeep', '');
  if (changelog !== null) write('CHANGELOG.md', changelog);

  git('add', '-A');
  git('commit', '-qm', 'baseline');
  git('push', '-q', 'origin', 'main');
  git('branch', 'dev');

  return {
    base,
    root,
    origin,
    git,
    originGit: (...args) => runIn(origin, args),
    write,
    writeFragment: (ref, options) => write(`.release/unreleased/${ref}.md`, fragmentText(ref, options)),
    commit: (message) => {
      git('add', '-A');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    },
    onBranch: (name) => git('checkout', '-q', name),
    remoteRefs: () => {
      const out = runIn(origin, ['show-ref']);
      return Object.fromEntries(
        out.split('\n').filter(Boolean).map((line) => {
          const [sha, ref] = line.split(' ');
          return [ref, sha];
        }),
      );
    },
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 3 }),
  };
}
