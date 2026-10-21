import fs from 'node:fs';
import path from 'node:path';

export interface IntegrationTestSelection {
  plugin: string;
  files: string[];
}

const MODULE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];
const STATIC_MODULE_SPECIFIER = /\b(?:import\s+(?:[^;'"()]*?\s+from\s*)?|export\s+[^;'"()]*?\s+from\s*|require\s*\(\s*)['"]([^'"\r\n]+)['"]/g;

function moduleIdentity(file: string): string {
  return path.resolve(file).replaceAll('\\', '/');
}

function sourceIdentity(file: string, plugin: string): string {
  const relative = path.relative(plugin, file).replaceAll('\\', '/');
  if (relative.startsWith('lib/')) {
    const source = moduleIdentity(path.join(plugin, 'src', relative)).replace(/\.[cm]?js$/, '.ts');
    if (fs.existsSync(source)) return source;
  }
  if (relative.startsWith('src/')) return moduleIdentity(file).replace(/\.[cm]?js$/, '.ts');
  return moduleIdentity(file);
}

function existingModule(file: string): string | undefined {
  return MODULE_EXTENSIONS.map((extension) => file + extension).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function importedModule(importer: string, specifier: string, plugin: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const imported = path.resolve(path.dirname(importer), specifier);
  const source = sourceIdentity(imported, plugin);
  return existingModule(source) ?? existingModule(imported);
}

function staticImports(file: string, plugin: string): string[] {
  const imports = Array.from(fs.readFileSync(file, 'utf8').matchAll(STATIC_MODULE_SPECIFIER), (match) => match[1]!);
  return imports.map((specifier) => importedModule(file, specifier, plugin)).filter((imported): imported is string => imported !== undefined);
}

function directoryFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entryFiles(directory, entry));
}

function entryFiles(directory: string, entry: fs.Dirent): string[] {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) return directoryFiles(file);
  return entry.isFile() ? [file] : [];
}

function importingTest(file: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function importedGraph(tests: string[], plugin: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = tests.slice();
  while (pending.length) recordImports(pending.pop()!, plugin, graph, pending);
  return graph;
}

function recordImports(file: string, plugin: string, graph: Map<string, string[]>, pending: string[]): void {
  const identity = moduleIdentity(file);
  if (graph.has(identity)) return;
  const imports = staticImports(file, plugin);
  graph.set(identity, imports.map(moduleIdentity));
  pending.push(...imports);
}

function dependentModules(graph: Map<string, string[]>, changed: Set<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const [importer, imports] of graph) {
    for (const imported of imports) dependents.set(imported, [...(dependents.get(imported) ?? []), importer]);
  }
  const affected = new Set(changed);
  const pending = Array.from(changed);
  while (pending.length) addDependents(pending.pop()!, dependents, affected, pending);
  return affected;
}

function addDependents(file: string, dependents: Map<string, string[]>, affected: Set<string>, pending: string[]): void {
  for (const dependent of dependents.get(file) ?? []) {
    if (affected.has(dependent)) continue;
    affected.add(dependent);
    pending.push(dependent);
  }
}

function pluginSelection(project: string, pluginName: string, changedPaths: string[]): IntegrationTestSelection {
  const plugin = path.join(project, 'plugins', pluginName);
  const tests = directoryFiles(path.join(plugin, 'test')).filter(importingTest);
  const graph = importedGraph(tests, plugin);
  const changed = new Set(changedPaths.map((file) => sourceIdentity(path.resolve(project, file), plugin)));
  const affected = dependentModules(graph, changed);
  return {
    plugin: `plugins/${pluginName}`,
    files: tests.filter((file) => affected.has(moduleIdentity(file))).map((file) => path.relative(plugin, file).replaceAll('\\', '/')).sort(),
  };
}

export function selectIntegrationTests(project: string, changedPaths: string[]): IntegrationTestSelection[] {
  const pluginNames = changedPaths.map((file) => /^plugins\/([^/]+)\//.exec(file.replaceAll('\\', '/'))?.[1]).filter((name): name is string => name !== undefined);
  return Array.from(new Set(pluginNames), (plugin) => pluginSelection(project, plugin, changedPaths));
}
