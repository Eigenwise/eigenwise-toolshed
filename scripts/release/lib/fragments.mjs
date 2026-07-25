import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, stringifyYaml, YamlError } from './yaml.mjs';
import { isLevel, LEVELS } from './semver.mjs';

export const RELEASE_DIR = '.release';
export const FRAGMENT_DIR = '.release/unreleased';
export const HOLD_FILE = '.release/HOLD';

const REF_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const KNOWN_KEYS = new Set(['ref', 'title', 'plugins', 'bump', 'commit', 'hold', 'category', 'story']);

export class FragmentError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.file = file;
    this.reason = message;
  }
}

export function fragmentFile(ref) {
  return path.posix.join(FRAGMENT_DIR, `${ref}.md`);
}

export function compareRefs(a, b) {
  const left = /^(.*?)-(\d+)$/.exec(a);
  const right = /^(.*?)-(\d+)$/.exec(b);
  if (left && right && left[1] === right[1]) return Number(left[2]) - Number(right[2]);
  return a.localeCompare(b);
}

function requireString(file, data, key, { optional = false } = {}) {
  const value = data[key];
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new FragmentError(file, `missing required field "${key}"`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FragmentError(file, `field "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function resolvePlugins(file, data) {
  const raw = data.plugins;
  if (raw === undefined || raw === null) throw new FragmentError(file, 'missing required field "plugins"');
  const fallback = data.bump ?? null;
  if (fallback !== null && !isLevel(fallback)) {
    throw new FragmentError(file, `bump "${fallback}" is not one of ${LEVELS.join(', ')}`);
  }

  const entries = [];
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new FragmentError(file, 'field "plugins" is empty');
    if (fallback === null) throw new FragmentError(file, 'a list of plugins needs a "bump" level');
    for (const name of raw) {
      if (typeof name !== 'string' || name.trim() === '') throw new FragmentError(file, 'field "plugins" has an empty entry');
      entries.push({ name: name.trim(), level: fallback });
    }
  } else if (raw !== null && typeof raw === 'object') {
    const names = Object.keys(raw);
    if (names.length === 0) throw new FragmentError(file, 'field "plugins" is empty');
    for (const name of names) {
      const level = raw[name] ?? fallback;
      if (level === null) throw new FragmentError(file, `plugin "${name}" has no bump level and the fragment has no "bump" default`);
      if (!isLevel(level)) throw new FragmentError(file, `plugin "${name}" has bump "${level}", expected one of ${LEVELS.join(', ')}`);
      entries.push({ name: name.trim(), level });
    }
  } else {
    throw new FragmentError(file, 'field "plugins" must be a list of names or a map of name to bump level');
  }

  const seen = new Set();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new FragmentError(file, `plugin "${entry.name}" is listed twice`);
    seen.add(key);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFragment(file, text, { knownPlugins = null } = {}) {
  const base = path.posix.basename(file);
  if (!base.endsWith('.md')) throw new FragmentError(file, 'fragments must be .md files');

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    if (error instanceof YamlError) throw new FragmentError(file, error.message);
    throw error;
  }
  const { data, body } = parsed;

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new FragmentError(file, `unknown field "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`);
    }
  }

  const ref = requireString(file, data, 'ref');
  if (!REF_PATTERN.test(ref)) throw new FragmentError(file, `ref "${ref}" does not look like a board ref (e.g. SQ-843)`);
  const stem = base.slice(0, -3);
  if (stem !== ref) throw new FragmentError(file, `filename must be "${ref}.md" to match its ref`);

  const title = requireString(file, data, 'title');
  const commit = requireString(file, data, 'commit', { optional: true });
  if (commit !== null && !COMMIT_PATTERN.test(commit)) {
    throw new FragmentError(file, `commit "${commit}" is not a 7-40 character lowercase hex sha`);
  }

  if (data.hold !== undefined && data.hold !== null && typeof data.hold !== 'boolean') {
    throw new FragmentError(file, 'field "hold" must be true or false');
  }

  const plugins = resolvePlugins(file, data);
  if (knownPlugins) {
    for (const entry of plugins) {
      if (!knownPlugins.has(entry.name)) {
        throw new FragmentError(
          file,
          `plugin "${entry.name}" is not published in .claude-plugin/marketplace.json, so it has no version to release`,
        );
      }
    }
  }

  return {
    ref,
    title,
    plugins,
    bump: data.bump ?? null,
    commit,
    hold: data.hold === true,
    category: requireString(file, data, 'category', { optional: true }),
    story: requireString(file, data, 'story', { optional: true }),
    body,
    file,
  };
}

export function renderFragment(fragment) {
  const plugins = Object.fromEntries(fragment.plugins.map((entry) => [entry.name, entry.level]));
  const levels = new Set(fragment.plugins.map((entry) => entry.level));
  const uniform = levels.size === 1 ? [...levels][0] : null;

  const front = {
    ref: fragment.ref,
    title: fragment.title,
    ...(uniform ? { bump: uniform, plugins: fragment.plugins.map((entry) => entry.name) } : { plugins }),
    ...(fragment.commit ? { commit: fragment.commit } : {}),
    ...(fragment.category ? { category: fragment.category } : {}),
    ...(fragment.story ? { story: fragment.story } : {}),
    ...(fragment.hold ? { hold: true } : {}),
  };

  const body = (fragment.body ?? '').trim();
  return `---\n${stringifyYaml(front)}\n---\n${body ? `\n${body}\n` : ''}`;
}

export function writeFragment(repoRoot, fragment, { force = false } = {}) {
  const relative = fragmentFile(fragment.ref);
  const absolute = path.join(repoRoot, relative);
  if (!force && existsSync(absolute)) {
    throw new FragmentError(relative, 'already exists; pass --force to overwrite it');
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, renderFragment(fragment));
  return relative;
}

/**
 * Reads every fragment, collecting failures rather than throwing on the first one so CI can
 * report all of them at once.
 */
export function readFragments(repoRoot, { knownPlugins = null } = {}) {
  const directory = path.join(repoRoot, FRAGMENT_DIR);
  const fragments = [];
  const errors = [];
  if (!existsSync(directory)) return { fragments, errors };

  const names = readdirSync(directory).filter((name) => name !== '.gitkeep' && !name.startsWith('.')).sort();
  for (const name of names) {
    const relative = path.posix.join(FRAGMENT_DIR, name);
    try {
      if (!name.endsWith('.md')) throw new FragmentError(relative, 'fragments must be .md files');
      fragments.push(parseFragment(relative, readFileSync(path.join(directory, name), 'utf8'), { knownPlugins }));
    } catch (error) {
      if (error instanceof FragmentError) errors.push(error);
      else throw error;
    }
  }

  const byRef = new Map();
  for (const fragment of fragments) {
    const key = fragment.ref.toLowerCase();
    const previous = byRef.get(key);
    if (previous) errors.push(new FragmentError(fragment.file, `duplicate ref "${fragment.ref}", already declared by ${previous.file}`));
    else byRef.set(key, fragment);
  }

  fragments.sort((a, b) => compareRefs(a.ref, b.ref));
  return { fragments, errors };
}

export function isHeld(repoRoot) {
  const absolute = path.join(repoRoot, HOLD_FILE);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf8').trim() || 'no reason given';
}
