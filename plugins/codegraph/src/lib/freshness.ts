import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { API } from 'typescript/unstable/sync' with { "resolution-mode": "import" };
import { canonicalFilesystemPath, normalizeProjectRelativePath } from './paths.js';
import type { ProjectDescriptor, SnapshotIdentity } from './model.js';
import type { FreshnessContributor, RelevantInputCandidate } from './runtime-contract.js';

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

async function inputCandidates(directory: string): Promise<RelevantInputCandidate[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : inputCandidates(entryPath);
    if (!entry.isFile() || (!isRelevantSource(entryPath) && !configurationNames.has(entry.name))) return [];
    return [{ absolutePath: entryPath, configuration: configurationNames.has(entry.name) }];
  }));
  return children.flat();
}

async function existingCanonicalPaths(candidates: ReadonlySet<string>): Promise<Set<string>> {
  const existing = new Set<string>();
  await Promise.all([...candidates].map(async (candidate) => {
    try {
      await access(candidate);
      existing.add(canonicalFilesystemPath(candidate));
    } catch { }
  }));
  return existing;
}

async function effectiveConfigurationPaths(projectRoot: string, discoveredInputs: readonly RelevantInputCandidate[]): Promise<Set<string>> {
  const rootConfigurations = discoveredInputs
    .filter((input) => input.configuration)
    .map((input) => path.resolve(input.absolutePath));
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
  return existingCanonicalPaths(semanticReads);
}

export class TypeScriptFreshnessContributor implements FreshnessContributor {
  async collect(projectRoot: string): Promise<readonly RelevantInputCandidate[]> {
    const discoveredInputs = await inputCandidates(projectRoot);
    const configurationPaths = await effectiveConfigurationPaths(projectRoot, discoveredInputs);
    return [
      ...discoveredInputs.filter((input) => !input.configuration),
      ...[...configurationPaths].map((absolutePath) => ({ absolutePath, configuration: true })),
    ];
  }
}

export const typeScriptFreshnessContributor = new TypeScriptFreshnessContributor();

function manifestPath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
    return normalizeProjectRelativePath(relativePath);
  }
  return `external-config/${contentHash(path.resolve(absolutePath))}`;
}

async function normalizedCandidates(
  projectRoot: string,
  contributors: readonly FreshnessContributor[],
): Promise<ReadonlyMap<string, boolean>> {
  const candidates = (await Promise.all(contributors.map((contributor) => contributor.collect(projectRoot)))).flat();
  const configurationByPath = new Map<string, boolean>();
  for (const candidate of candidates) {
    try {
      await access(candidate.absolutePath);
      const canonicalPath = canonicalFilesystemPath(candidate.absolutePath);
      configurationByPath.set(canonicalPath, configurationByPath.get(canonicalPath) === true || candidate.configuration);
    } catch { }
  }
  return configurationByPath;
}

/** Hashes every centrally deduplicated source and effective configuration input from every installed provider. */
export async function buildRelevantInputManifest(
  projectRoot: string,
  contributors: readonly FreshnessContributor[] = [typeScriptFreshnessContributor],
): Promise<RelevantInputManifest> {
  const canonicalRoot = canonicalFilesystemPath(projectRoot);
  const candidates = await normalizedCandidates(canonicalRoot, contributors);
  const inputs = await Promise.all([...candidates].map(async ([absolutePath, configuration]) => ({
    path: manifestPath(canonicalRoot, absolutePath),
    contentHash: contentHash(await readFile(absolutePath, 'utf8')),
    configuration,
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
