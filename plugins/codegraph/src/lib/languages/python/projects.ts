import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProjectRoot, projectIdentity } from '../../paths.js';
import type { ProjectDescriptor } from '../../model.js';

const configurationNames = new Set(['pyrightconfig.json', 'pyproject.toml']);
const ignoredDirectories = new Set([
  '.git', '.eggs', '.mypy_cache', '.nox', '.pytest_cache', '.ruff_cache', '.tox',
  '__pycache__', 'build', 'dist', 'env', 'node_modules', 'venv', 'virtualenv',
]);
const virtualEnvironmentMarker = 'pyvenv.cfg';

export interface PythonProjectConfiguration {
  readonly absolutePath: string;
  readonly configurationName: 'pyrightconfig.json' | 'pyproject.toml';
}

function pythonConfigurationPriority(configuration: PythonProjectConfiguration): number {
  return configuration.configurationName === 'pyrightconfig.json' ? 0 : 1;
}

function isPythonSource(fileName: string): boolean {
  return fileName.endsWith('.py') || fileName.endsWith('.pyi');
}

function isPythonBuildBackend(value: string): boolean {
  return /(?:flit|hatch|maturin|pdm|poetry|setuptools|uv)/i.test(value);
}

/** Limits pyproject discovery to Python tooling rather than treating every polyglot manifest as Python. */
export function isPythonPyproject(contents: string): boolean {
  return /^\s*requires-python\s*=/mi.test(contents)
    || /^\s*\[tool\.(?:pyright|poetry|hatch(?:\.[^\]]+)?|pdm|setuptools(?:\.[^\]]+)?|flit(?:\.[^\]]+)?|uv(?:\.[^\]]+)?)\]/mi.test(contents)
    || /^\s*build-backend\s*=\s*["']([^"']+)["']/mi.test(contents)
      && isPythonBuildBackend(contents.match(/^\s*build-backend\s*=\s*["']([^"']+)["']/mi)?.[1] ?? '');
}

async function isVirtualEnvironment(directory: string): Promise<boolean> {
  if (ignoredDirectories.has(path.basename(directory))) return true;
  try {
    await access(path.join(directory, virtualEnvironmentMarker));
    return true;
  } catch {
    return false;
  }
}

async function configurationAt(filePath: string): Promise<PythonProjectConfiguration | null> {
  const configurationName = path.basename(filePath);
  if (configurationName === 'pyrightconfig.json') {
    return { absolutePath: filePath, configurationName };
  }
  if (configurationName !== 'pyproject.toml') return null;
  try {
    return isPythonPyproject(await readFile(filePath, 'utf8'))
      ? { absolutePath: filePath, configurationName }
      : null;
  } catch {
    return null;
  }
}

async function walkPythonTree(
  directory: string,
  configurations: PythonProjectConfiguration[],
  pythonFiles: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!await isVirtualEnvironment(entryPath)) await walkPythonTree(entryPath, configurations, pythonFiles);
      return;
    }
    if (!entry.isFile()) return;
    if (configurationNames.has(entry.name)) {
      const configuration = await configurationAt(entryPath);
      if (configuration !== null) configurations.push(configuration);
    }
    if (isPythonSource(entry.name)) pythonFiles.push(entryPath);
  }));
}

function descriptor(root: string, configFile: string | null): ProjectDescriptor {
  const normalizedRoot = normalizeProjectRoot(root);
  return {
    id: projectIdentity(normalizedRoot),
    root: normalizedRoot,
    configFile: configFile === null ? null : normalizeProjectRoot(configFile),
    language: 'python',
  };
}

function sourceRoots(projectRoot: string, pythonFiles: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const pythonFile of pythonFiles) {
    let directory = path.dirname(pythonFile);
    while (directory !== projectRoot && directory !== path.dirname(directory)) {
      if (path.basename(directory) === 'src') {
        roots.add(directory);
        break;
      }
      directory = path.dirname(directory);
    }
  }
  if (roots.size === 0 && pythonFiles.length > 0) roots.add(projectRoot);
  return [...roots].sort((left, right) => left.localeCompare(right));
}

/** Discovers Python configurations first, then source roots, with one stable fallback for unconfigured trees. */
export async function discoverPythonProjects(projectRoot: string): Promise<ProjectDescriptor[]> {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const configurations: PythonProjectConfiguration[] = [];
  const pythonFiles: string[] = [];
  await walkPythonTree(normalizedRoot, configurations, pythonFiles);

  const selectedConfigurations = new Map<string, PythonProjectConfiguration>();
  for (const configuration of configurations.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))) {
    const root = normalizeProjectRoot(path.dirname(configuration.absolutePath));
    const current = selectedConfigurations.get(root);
    if (current === undefined || pythonConfigurationPriority(configuration) < pythonConfigurationPriority(current)) {
      selectedConfigurations.set(root, configuration);
    }
  }
  const configuredProjects = [...selectedConfigurations.entries()]
    .map(([root, configuration]) => descriptor(root, configuration.absolutePath))
    .sort((left, right) => (left.configFile ?? '').localeCompare(right.configFile ?? ''));
  if (configuredProjects.length > 0) return configuredProjects;

  return sourceRoots(normalizedRoot, pythonFiles).map((root) => descriptor(root, null));
}
