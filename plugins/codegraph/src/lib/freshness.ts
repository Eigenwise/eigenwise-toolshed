import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProjectRelativePath } from './paths.js';
import type { ProjectDescriptor, SnapshotIdentity } from './model.js';

const relevantExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
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

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestHash(inputs: readonly RelevantInput[]): string {
  return createHash('sha256')
    .update(inputs.map((input) => `${input.path}\0${input.contentHash}\0${input.configuration}`).join('\n'))
    .digest('hex');
}

function isRelevantInput(filePath: string): boolean {
  const fileName = path.basename(filePath);
  return fileName === 'tsconfig.json' || fileName === 'jsconfig.json' || relevantExtensions.has(path.extname(filePath));
}

async function relevantInputPaths(projectRoot: string, directory: string = projectRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : relevantInputPaths(projectRoot, entryPath);
    return entry.isFile() && isRelevantInput(entryPath) ? [entryPath] : [];
  }));
  return children.flat();
}

/** Hashes every source and config input so filesystem changes invalidate a prior snapshot. */
export async function buildRelevantInputManifest(projectRoot: string): Promise<RelevantInputManifest> {
  const absoluteInputs = await relevantInputPaths(projectRoot);
  const inputs = await Promise.all(absoluteInputs.map(async (absolutePath) => {
    const relativePath = normalizeProjectRelativePath(path.relative(projectRoot, absolutePath));
    return {
      path: relativePath,
      contentHash: contentHash(await readFile(absolutePath, 'utf8')),
      configuration: path.basename(absolutePath) === 'tsconfig.json' || path.basename(absolutePath) === 'jsconfig.json',
    };
  }));
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
