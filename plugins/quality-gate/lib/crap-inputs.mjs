import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonPolicy, pythonOracles } from './python.mjs';

export const JAVASCRIPT_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx|py|php|vue)$/i;

export function runGit(root, argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${argumentsList[0]} failed: ${result.stderr || result.error?.message}. Check the project path and base revision, then rerun the gate.`);
  return argumentsList[0] === 'show' ? result.stdout : result.stdout.trim();
}

export function tryGit(root, argumentsList) {
  try { return runGit(root, argumentsList); } catch { return null; }
}

export function projectRoot(project) {
  const requested = path.resolve(project);
  return tryGit(requested, ['rev-parse', '--show-toplevel']) || requested;
}

export function readConfig(root) {
  const current = path.join(root, '.claude/quality-gate/crap.json');
  const legacy = path.join(root, '.claude/quartermaster/crap.json');
  const configPath = fs.existsSync(current) ? current : legacy;
  if (!fs.existsSync(configPath)) return { config: {}, warnings: [] };
  const config = parseConfig(configPath);
  return { config, warnings: configPath === legacy ? ['Reading .claude/quartermaster/crap.json; move it to .claude/quality-gate/crap.json.'] : [] };
}

function parseConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    validateConfig(config);
    return config;
  } catch (error) {
    throw new Error('Could not read ' + configPath + ': ' + error.message + '. Fix the config file, then rerun the gate.');
  }
}

function validateConfig(config) {
  if (Object.prototype.toString.call(config) !== '[object Object]') throw new Error('Config must be a JSON object');
  for (const key of ['sources', 'exclude']) validateStringArray(config[key], key);
  for (const key of ['base', 'ratchet', 'lcov', 'coverageCommand', 'pythonPolicy']) validateString(config[key], key);
}

function validateStringArray(value, key) {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error(key + ' must be an array of strings');
}

function validateString(value, key) {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(key + ' must be a string');
}

function firstDefined(values) {
  return values.find((value) => value != null);
}

function assertCcOnlyOptions(options) {
  if (options.ccOnly && firstDefined([options.lcov, options.coverageCommand])) throw new Error('--cc-only runs no coverage. Drop --cc-only, or drop --lcov and --coverage-command.');
}

export function gateSettings(options, config) {
  assertCcOnlyOptions(options);
  if (Number(firstDefined([options.max, config.max, 6])) !== 6) throw new Error('The CRAP threshold is fixed at 6. Remove max from the command or config.');
  const policy = pythonPolicy(firstDefined([options.pythonPolicy, config.pythonPolicy]));
  return {
    pythonPolicy: policy, pythonOracles: pythonOracles(Object.hasOwn(options, "pythonOracles") ? options.pythonOracles : config.pythonOracles, policy),
    source: options.source, sources: config.sources?.length ? config.sources : ['.'], exclude: firstDefined([config.exclude, []]),
    base: firstDefined([options.base, config.base, options.ratchet, config.ratchet]),
    lcov: options.lcov, fallbackLcov: config.lcov, coverageCommand: firstDefined([options.coverageCommand, config.coverageCommand]),
    usedDeprecatedRatchet: !firstDefined([options.base, config.base]) && Boolean(firstDefined([options.ratchet, config.ratchet])),
  };
}

function directoryFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', 'node_modules', '.claude'].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? directoryFiles(target) : [target];
  });
}

function filesAt(target) {
  if (!fs.existsSync(target)) return [];
  return fs.statSync(target).isDirectory() ? directoryFiles(target) : [target];
}

export function selectedFiles(root, settings) {
  const requested = settings.source && new Set(settings.source.flatMap((source) => filesAt(path.resolve(root, source))));
  return [...new Set(settings.sources.flatMap((source) => filesAt(path.resolve(root, source))))]
    .filter((file) => SOURCE.test(file))
    .filter((file) => !requested || requested.has(file))
    .map((file) => path.relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !settings.exclude.some((pattern) => path.matchesGlob(file, pattern)));
}

// With a base, only files that differ from it (or are new and untracked) can hold changed bodies, so
// the rest are never parsed (GH-554).
export function filesChangedSince(root, base, files) {
  if (!base) return files;
  const listed = (argumentsList) => runGit(root, [...argumentsList, '-z']).split('\0');
  const changed = new Set([...listed(['diff', '--name-only', '--no-renames', base]), ...listed(['ls-files', '--others', '--exclude-standard'])]);
  return files.filter((file) => changed.has(file));
}

function pathSelected(root, file, sources) {
  return sources.some((source) => {
    const selected = path.relative(root, path.resolve(root, source)).replaceAll('\\', '/');
    return selected === '' || file === selected || file.startsWith(selected + '/');
  });
}

export function selectedDeletedFiles(root, base, settings) {
  if (!base) return [];
  return runGit(root, ['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', base]).split('\0')
    .filter((file) => SOURCE.test(file))
    .filter((file) => pathSelected(root, file, settings.sources))
    .filter((file) => !settings.source || pathSelected(root, file, settings.source))
    .filter((file) => !settings.exclude.some((pattern) => path.matchesGlob(file, pattern)));
}

export function sourceHashes(root, files) {
  return Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex')]));
}

export function baseRevision(root, requested) {
  const reference = firstDefined([requested, ['develop', 'main', 'master'].find((candidate) => tryGit(root, ['rev-parse', '--verify', '--quiet', candidate]))]);
  if (!tryGit(root, ['rev-parse', '--verify', 'HEAD'])) return { base: null, warnings: [] };
  if (!reference || reference === 'HEAD') return { base: null, warnings: [] };
  const base = runGit(root, ['merge-base', 'HEAD', reference]);
  const behind = Number(tryGit(root, ['rev-list', '--count', `${reference}..${reference}@{upstream}`]));
  return { base, warnings: behind > 0 ? [`Local base ${reference} is ${behind} commits behind its upstream. Pass --base ${reference}@{upstream}, or fetch and fast-forward ${reference}.`] : [] };
}
