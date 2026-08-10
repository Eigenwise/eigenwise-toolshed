import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FreshnessContributor, RelevantInputCandidate } from '../../runtime-contract.js';
import { isPythonPyproject } from './projects.js';

const ignoredDirectories = new Set([
  '.git', '.eggs', '.mypy_cache', '.nox', '.pytest_cache', '.ruff_cache', '.tox',
  '__pycache__', 'build', 'dist', 'env', 'node_modules', 'venv', 'virtualenv',
]);
const configurationNames = new Set(['pyrightconfig.json', 'pyproject.toml']);

function isPythonSource(fileName: string): boolean {
  return fileName.endsWith('.py') || fileName.endsWith('.pyi');
}

async function isVirtualEnvironment(directory: string): Promise<boolean> {
  if (ignoredDirectories.has(path.basename(directory))) return true;
  try {
    await access(path.join(directory, 'pyvenv.cfg'));
    return true;
  } catch {
    return false;
  }
}

async function isRelevantConfiguration(filePath: string): Promise<boolean> {
  if (path.basename(filePath) === 'pyrightconfig.json') return true;
  if (path.basename(filePath) !== 'pyproject.toml') return false;
  try {
    return isPythonPyproject(await readFile(filePath, 'utf8'));
  } catch {
    return false;
  }
}

async function inputCandidates(directory: string): Promise<RelevantInputCandidate[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return await isVirtualEnvironment(entryPath) ? [] : inputCandidates(entryPath);
    if (!entry.isFile()) return [];
    if (isPythonSource(entry.name)) return [{ absolutePath: entryPath, configuration: false }];
    return await isRelevantConfiguration(entryPath) ? [{ absolutePath: entryPath, configuration: true }] : [];
  }));
  return children.flat();
}

function stripJsonComments(contents: string): string {
  let result = '';
  let quoted = false;
  let escaping = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index]!;
    const next = contents[index + 1];
    if (quoted) {
      result += character;
      if (escaping) escaping = false;
      else if (character === '\\') escaping = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      result += character;
      continue;
    }
    if (character === '/' && next === '/') {
      index = contents.indexOf('\n', index);
      if (index === -1) break;
      result += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      const closingIndex = contents.indexOf('*/', index + 2);
      index = closingIndex === -1 ? contents.length : closingIndex + 1;
      continue;
    }
    result += character;
  }
  return result;
}

function jsonExtends(contents: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(contents));
    if (typeof parsed !== 'object' || parsed === null || !('extends' in parsed)) return null;
    return typeof parsed.extends === 'string' ? parsed.extends : null;
  } catch {
    return null;
  }
}

function pyprojectExtends(contents: string): string | null {
  const pyrightLines: string[] = [];
  let inPyrightSection = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*\[tool\.pyright\]\s*$/i.test(line)) {
      inPyrightSection = true;
      continue;
    }
    if (inPyrightSection && /^\s*\[/.test(line)) break;
    if (inPyrightSection) pyrightLines.push(line);
  }
  return pyrightLines.join('\n').match(/^\s*extends\s*=\s*["']([^"']+)["']/mi)?.[1] ?? null;
}

async function inheritedConfigurationPath(configFile: string): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(configFile, 'utf8');
  } catch {
    return null;
  }
  const extendsPath = path.basename(configFile) === 'pyproject.toml'
    ? pyprojectExtends(contents)
    : jsonExtends(contents);
  if (extendsPath === null || extendsPath.trim() === '') return null;
  const resolvedPath = path.resolve(path.dirname(configFile), extendsPath);
  try {
    await access(resolvedPath);
    return resolvedPath;
  } catch {
    return null;
  }
}

async function effectiveConfigurationPaths(inputs: readonly RelevantInputCandidate[]): Promise<string[]> {
  const pending = inputs.filter((input) => input.configuration).map((input) => path.resolve(input.absolutePath));
  const resolved = new Set<string>();
  while (pending.length > 0) {
    const configFile = pending.pop()!;
    if (resolved.has(configFile)) continue;
    resolved.add(configFile);
    const inheritedPath = await inheritedConfigurationPath(configFile);
    if (inheritedPath !== null) pending.push(inheritedPath);
  }
  return [...resolved].sort((left, right) => left.localeCompare(right));
}

/** Collects Python source/stub files and effective Pyright configuration without loading project code. */
export class PythonFreshnessContributor implements FreshnessContributor {
  async collect(projectRoot: string): Promise<readonly RelevantInputCandidate[]> {
    const discoveredInputs = await inputCandidates(projectRoot);
    const effectiveConfigurations = await effectiveConfigurationPaths(discoveredInputs);
    const sourceInputs = discoveredInputs.filter((input) => !input.configuration);
    return [...sourceInputs, ...effectiveConfigurations.map((absolutePath) => ({ absolutePath, configuration: true }))]
      .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  }
}

export const pythonFreshnessContributor = new PythonFreshnessContributor();
