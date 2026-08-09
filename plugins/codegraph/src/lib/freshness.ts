import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { API } from 'typescript/unstable/sync' with { "resolution-mode": "import" };
import { normalizeProjectRelativePath } from './paths.js';
import type { ProjectDescriptor, SnapshotIdentity } from './model.js';

const relevantExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const configurationNames = new Set(['tsconfig.json', 'jsconfig.json']);
const ignoredDirectories = new Set(['.git', 'node_modules']);

export interface RelevantInput {
  readonly path: string;
  readonly contentHash: string;
  readonly configuration: boolean;
}

export interface RelevantInputManifest {
  readonly inputs: readonly RelevantInput[];
  readonly sourceManifestHash: string;
  readonly configHash: string;
}

interface SemanticTypeScriptModule {
  readonly API: new (options?: {
    readonly cwd?: string;
    readonly fs?: { readonly readFile?: (fileName: string) => string | null | undefined };
  }) => API;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestHash(inputs: readonly RelevantInput[]): string {
  return createHash('sha256')
    .update(inputs.map((input) => `${input.path}\0${input.contentHash}\0${input.configuration}`).join('\n'))
    .digest('hex');
}

function isRelevantSource(filePath: string): boolean {
  return relevantExtensions.has(path.extname(filePath));
}

function importEsmModule(specifier: string): Promise<unknown> {
  return new Function('moduleSpecifier', 'return import(moduleSpecifier);')(specifier);
}

function isSemanticTypeScriptModule(value: unknown): value is SemanticTypeScriptModule {
  return typeof value === 'object' && value !== null && 'API' in value && typeof value.API === 'function';
}

async function loadSemanticTypeScript(): Promise<SemanticTypeScriptModule> {
  const semanticTypeScript = await importEsmModule('typescript/unstable/sync');
  if (!isSemanticTypeScriptModule(semanticTypeScript)) {
    throw new Error('the pinned TypeScript runtime does not expose its sync semantic API');
  }
  return semanticTypeScript;
}

async function inputPaths(projectRoot: string, directory: string = projectRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : inputPaths(projectRoot, entryPath);
    return entry.isFile() && (isRelevantSource(entryPath) || configurationNames.has(entry.name)) ? [entryPath] : [];
  }));
  return children.flat();
}

async function existingPaths(candidates: ReadonlySet<string>): Promise<Set<string>> {
  const existing = new Set<string>();
  await Promise.all([...candidates].map(async (candidate) => {
    try {
      await access(candidate);
      existing.add(candidate);
    } catch { }
  }));
  return existing;
}

async function effectiveConfigurationPaths(projectRoot: string, discoveredInputs: readonly string[]): Promise<Set<string>> {
  const rootConfigurations = discoveredInputs
    .filter((filePath) => configurationNames.has(path.basename(filePath)))
    .map((filePath) => path.resolve(filePath));
  const semanticReads = new Set(rootConfigurations);
  const semanticTypeScript = await loadSemanticTypeScript();
  const api = new semanticTypeScript.API({
    cwd: projectRoot,
    fs: {
      readFile(fileName) {
        semanticReads.add(path.resolve(fileName));
        return undefined;
      },
    },
  });
  try {
    for (const configFile of rootConfigurations) api.parseConfigFile(configFile);
  } finally {
    api.close();
  }
  return existingPaths(semanticReads);
}

function manifestPath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
    return normalizeProjectRelativePath(relativePath);
  }
  return `external-config/${contentHash(path.resolve(absolutePath))}`;
}

/** Hashes every source and effective TypeScript configuration input so filesystem changes invalidate a prior snapshot. */
export async function buildRelevantInputManifest(projectRoot: string): Promise<RelevantInputManifest> {
  const discoveredInputs = await inputPaths(projectRoot);
  const configurationPaths = await effectiveConfigurationPaths(projectRoot, discoveredInputs);
  const absoluteInputs = [...new Set([...discoveredInputs.filter((input) => !configurationNames.has(path.basename(input))), ...configurationPaths])];
  const inputs = await Promise.all(absoluteInputs.map(async (absolutePath) => ({
    path: manifestPath(projectRoot, absolutePath),
    contentHash: contentHash(await readFile(absolutePath, 'utf8')),
    configuration: configurationPaths.has(absolutePath),
  })));
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const configurationInputs = inputs.filter((input) => input.configuration);
  return {
    inputs,
    sourceManifestHash: manifestHash(inputs),
    configHash: manifestHash(configurationInputs),
  };
}

export function snapshotIsFresh(snapshot: SnapshotIdentity, manifest: RelevantInputManifest): boolean {
  return snapshot.sourceManifestHash === manifest.sourceManifestHash
    && snapshot.configHash === manifest.configHash;
}

export function projectInputs(manifest: RelevantInputManifest, project: ProjectDescriptor): RelevantInput[] {
  const projectRelativeRoot = path.relative(path.dirname(project.root), project.root).replaceAll('\\', '/');
  return manifest.inputs.filter((input) => projectRelativeRoot === '' || input.path.startsWith(`${projectRelativeRoot}/`));
}
