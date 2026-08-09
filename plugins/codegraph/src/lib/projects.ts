import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectIdentity, normalizeProjectRoot } from './paths.js';
import type { ProjectDescriptor } from './model.js';

const configurationNames = new Set(['tsconfig.json', 'jsconfig.json']);
const ignoredDirectories = new Set(['.git', 'node_modules']);

interface ProjectConfiguration {
  readonly references?: readonly { readonly path?: string }[];
  readonly files?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

function removeJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasProperty(value: object, property: string): value is Record<string, unknown> {
  return property in value;
}

function optionalProperty(value: object, property: string): unknown {
  return hasProperty(value, property) ? value[property] : undefined;
}

function isProjectConfiguration(value: unknown): value is ProjectConfiguration {
  if (typeof value !== 'object' || value === null) return false;
  const references = optionalProperty(value, 'references');
  const files = optionalProperty(value, 'files');
  const include = optionalProperty(value, 'include');
  const exclude = optionalProperty(value, 'exclude');
  return (references === undefined || Array.isArray(references))
    && (files === undefined || isStringArray(files))
    && (include === undefined || isStringArray(include))
    && (exclude === undefined || isStringArray(exclude));
}

async function readConfiguration(configFile: string): Promise<ProjectConfiguration> {
  const text = await readFile(configFile, 'utf8');
  try {
    const parsed: unknown = JSON.parse(removeJsonComments(text));
    return isProjectConfiguration(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function configurationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : configurationFiles(entryPath);
    }
    return entry.isFile() && configurationNames.has(entry.name) ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}

function isSolutionConfiguration(configuration: ProjectConfiguration): boolean {
  return (configuration.references?.length ?? 0) > 0
    && configuration.files === undefined
    && configuration.include === undefined
    && configuration.exclude === undefined;
}

function languageForConfig(configFile: string): string {
  return path.basename(configFile) === 'jsconfig.json' ? 'javascript' : 'typescript';
}

function descriptorForConfig(configFile: string): ProjectDescriptor {
  const root = normalizeProjectRoot(path.dirname(configFile));
  return {
    id: projectIdentity(root),
    root,
    configFile: normalizeProjectRoot(configFile),
    language: languageForConfig(configFile),
  };
}

/** Discovers configured leaf projects and falls back only for config-free repositories. */
export async function discoverProjects(projectRoot: string): Promise<ProjectDescriptor[]> {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const discoveredConfigFiles = await configurationFiles(normalizedRoot);
  const configurations = await Promise.all(discoveredConfigFiles.map(async (configFile) => ({
    configFile,
    configuration: await readConfiguration(configFile),
  })));
  const leafProjects = configurations
    .filter(({ configuration }) => !isSolutionConfiguration(configuration))
    .map(({ configFile }) => descriptorForConfig(configFile))
    .sort((left, right) => (left.configFile ?? '').localeCompare(right.configFile ?? ''));

  if (leafProjects.length > 0) return leafProjects;
  if (discoveredConfigFiles.length > 0) return [];

  return [{
    id: projectIdentity(normalizedRoot),
    root: normalizedRoot,
    configFile: null,
    language: 'typescript',
  }];
}

export function projectConfigFiles(projects: readonly ProjectDescriptor[]): string[] {
  return projects
    .map((project) => project.configFile)
    .filter((configFile): configFile is string => configFile !== null)
    .sort();
}
