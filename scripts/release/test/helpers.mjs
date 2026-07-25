import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_SHA = 'c7b2702b2e2f041dff7fe513710de83d89198c55';
export const DEFAULT_DATE = '2026-07-25';

export function marketplaceJson({ version, plugins }) {
  return `${JSON.stringify({
    name: 'eigenwise-toolshed',
    owner: { name: 'Eigenwise', email: 'kenny@eigenwise.io' },
    description: "Eigenwise's toolshed of Claude Code plugins.",
    version,
    plugins: Object.entries(plugins).map(([name, pluginVersion]) => ({
      name,
      source: `./plugins/${name}`,
      description: `${name} plugin`,
      version: pluginVersion,
      repository: 'https://github.com/Eigenwise/eigenwise-toolshed',
      license: 'MIT',
    })),
  }, null, 2)}\n`;
}

export function fragmentText(ref, { title = `${ref} title`, plugins, bump = null, commit = null, hold = false, body = '', extra = null } = {}) {
  const lines = ['---', `ref: ${ref}`, `title: ${title}`];
  if (bump) lines.push(`bump: ${bump}`);
  if (Array.isArray(plugins)) lines.push(`plugins: [${plugins.join(', ')}]`);
  else {
    lines.push('plugins:');
    for (const [name, level] of Object.entries(plugins)) lines.push(`  ${name}: ${level}`);
  }
  if (commit) lines.push(`commit: ${commit}`);
  if (hold) lines.push('hold: true');
  if (extra) lines.push(extra);
  lines.push('---');
  return `${lines.join('\n')}\n${body ? `\n${body}\n` : ''}`;
}

/**
 * A throwaway checkout with the two manifest shapes the engine reads. No git: anything that
 * depends on a commit, a ref, or a remote belongs in realrepo.mjs, where it is real.
 */
export function makeRepo({
  plugins = { sidequest: '3.6.49' },
  marketplaceVersion = '3.207.0',
  fragments = {},
  rawFragments = {},
  changelog = null,
  hold = null,
  suites = {},
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-engine-'));

  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, '.claude-plugin/marketplace.json'), marketplaceJson({ version: marketplaceVersion, plugins }));

  for (const [name, version] of Object.entries(plugins)) {
    const dir = path.join(root, 'plugins', name, '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify({ name, version, description: `${name} plugin`, license: 'MIT' }, null, 2)}\n`);

    if (suites[name] === 'package') {
      writeFileSync(path.join(root, 'plugins', name, 'package.json'), `${JSON.stringify({ name, scripts: { 'test:full': 'node --test' } }, null, 2)}\n`);
    }
    if (suites[name] === 'testdir') {
      mkdirSync(path.join(root, 'plugins', name, 'test'), { recursive: true });
      writeFileSync(path.join(root, 'plugins', name, 'test', 'a.test.js'), '');
    }
  }

  mkdirSync(path.join(root, '.release/unreleased'), { recursive: true });
  for (const [ref, options] of Object.entries(fragments)) {
    writeFileSync(path.join(root, '.release/unreleased', `${ref}.md`), fragmentText(ref, options));
  }
  for (const [name, text] of Object.entries(rawFragments)) {
    writeFileSync(path.join(root, '.release/unreleased', name), text);
  }
  if (hold !== null) writeFileSync(path.join(root, '.release/HOLD'), hold);
  if (changelog !== null) writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

/** Answers `git show <ref>:<path>` from a map and nothing else. */
export function fileGit(files = {}) {
  return (args) => {
    if (args[0] !== 'show') return { code: 0, stdout: '', stderr: '' };
    const file = args[1].slice(args[1].indexOf(':') + 1);
    return Object.hasOwn(files, file)
      ? { code: 0, stdout: files[file], stderr: '' }
      : { code: 128, stdout: '', stderr: `path '${file}' does not exist` };
  };
}
