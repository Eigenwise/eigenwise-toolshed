import fs from 'node:fs';
import path from 'node:path';
import type { VerificationResult } from './kernel/verification.js';
import { runProcessVerification } from './ports/process.js';

export interface IntegrationTestSelection {
  plugin: string;
  files: string[];
  excludedFiles?: string[];
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
  const guidance = changedPaths.some(guidancePath) ? tests.filter((file) => /(?:^|[/\\])(?:agent-guidance|skill|compatibility)\.test\.[jt]s$/.test(file)) : [];
  const graph = importedGraph(tests, plugin);
  const changed = new Set(changedPaths.map((file) => sourceIdentity(path.resolve(project, file), plugin)));
  const affected = dependentModules(graph, changed);
  return {
    plugin: `plugins/${pluginName}`,
    files: tests.filter((file) => affected.has(moduleIdentity(file)) || guidance.includes(file)).map((file) => path.relative(plugin, file).replaceAll('\\', '/')).sort(),
  };
}

export interface IntegrationTestBatch {
  plugin: string;
  files: string[];
  command: string;
  timeoutMilliseconds: number;
  shape: 'selected-files' | 'test:full' | 'npm-test';
}

function quoteArgument(value: string): string {
  if (process.platform === 'win32') return '"' + value.replaceAll('"', '""') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function pinnedTestPatterns(command: string): string[] {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), (match) => (match[1] ?? match[2] ?? match[3]!).replaceAll('\\', '/'));
}

function pinnedTestFile(selection: IntegrationTestSelection, file: string, patterns: string[]): boolean {
  const pluginPaths = patterns.filter((pattern) => pattern.startsWith('plugins/'));
  const localPathsApply = pluginPaths.length === 0 || pluginPaths.some((pattern) => pattern.startsWith(selection.plugin + '/')) || pluginPaths.includes(selection.plugin);
  return patterns.some((pattern) => (localPathsApply && path.matchesGlob(file, pattern)) || path.matchesGlob(`${selection.plugin}/${file}`, pattern));
}

function performanceTest(file: string): boolean {
  return /(?:^|[./_-])(?:perf|benchmark)(?:[./_-]|$)/i.test(file);
}

function testScripts(project: string, plugin: string): Record<string, string> {
  const manifestPath = path.join(project, plugin, 'package.json');
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts ?? {};
}

function pluginTestFiles(project: string, plugin: string): string[] {
  const root = path.join(project, plugin);
  return directoryFiles(path.join(root, 'test')).filter(importingTest).map((file) => path.relative(root, file).replaceAll('\\', '/')).sort();
}

function testBatchCommand(scripts: Record<string, string>, files: string[], normalSuite: boolean): string {
  if (normalSuite) return scripts['test:full'] ? 'npm run test:full' : 'npm test';
  const runner = scripts['test:files'] ? 'npm run test:files --' : 'node --test';
  return runner + ' --test-concurrency=1 ' + files.map((file) => quoteArgument(file.replaceAll('[', '[[]'))).join(' ');
}

function pluginTestBatch(project: string, selection: IntegrationTestSelection, patterns: string[], timeoutMilliseconds: number, fileThreshold: number): IntegrationTestBatch[] {
  const files = selection.files.filter((file) => !performanceTest(file) && !pinnedTestFile(selection, file, patterns));
  if (!files.length) return [];
  const normalSuite = files.length > fileThreshold;
  const batchFiles = normalSuite ? pluginTestFiles(project, selection.plugin).filter((file) => !performanceTest(file)) : files;
  const scripts = testScripts(project, selection.plugin);
  return [{
    plugin: selection.plugin,
    files: batchFiles,
    command: testBatchCommand(scripts, batchFiles, normalSuite),
    timeoutMilliseconds,
    shape: normalSuite ? (scripts['test:full'] ? 'test:full' : 'npm-test') : 'selected-files',
  }];
}

export function integrationTestBatches(project: string, selections: IntegrationTestSelection[], pinnedCommand: string, timeoutMilliseconds: number, fileThreshold = 40): IntegrationTestBatch[] {
  if (/\btest:full\b/.test(pinnedCommand)) return [];
  const patterns = pinnedTestPatterns(pinnedCommand);
  return selections.flatMap((selection) => pluginTestBatch(project, selection, patterns, timeoutMilliseconds, fileThreshold));
}

function selectionWithExclusions(project: string, selection: IntegrationTestSelection): IntegrationTestSelection {
  const excludedFiles = pluginTestFiles(project, selection.plugin).filter(performanceTest);
  return { ...selection, excludedFiles };
}

function executeImportBatches(project: string, batches: IntegrationTestBatch[], pinned: VerificationResult, environment: NodeJS.ProcessEnv): VerificationResult[] {
  if (pinned.status !== 'passed') return [];
  const failures: VerificationResult[] = [];
  for (const [index, batch] of batches.entries()) {
    reportIntegrationProgress('importing tests', `${batch.plugin}/${batch.files.join(', ')}`, { index: index + 1, count: batches.length });
    const started = Date.now();
    const result = runProcessVerification({ kind: 'command', command: batch.command, evidenceContract: 'Importing tests pass on the merged tree' }, {
      cwd: path.join(project, batch.plugin),
      timeoutMilliseconds: batch.timeoutMilliseconds,
      logPath: pinned.logPath + '.import-' + index + '.log',
      environment,
    });
    const receipt = { ...result, batchShape: batch.shape, timeoutMilliseconds: batch.timeoutMilliseconds, durationMilliseconds: Date.now() - started };
    if (pinned.logPath) fs.appendFileSync(pinned.logPath, '\nImport-walk batch: ' + JSON.stringify(receipt) + '\n');
    if (result.status !== 'passed') { failures.push(receipt); break; }
  }
  return failures;
}

export function runImportingIntegrationTests(project: string, changedPaths: string[], pinned: VerificationResult, timeoutMilliseconds: number, environment: NodeJS.ProcessEnv, fileThreshold = 40): VerificationResult & { integrationTests: IntegrationTestSelection[]; importingTestResults: VerificationResult[]; importingTestSummary: { selectedFiles: number; durationMilliseconds: number; timeoutMilliseconds: number; exclusionReason: string } } {
  const started = Date.now();
  const selections = selectIntegrationTests(project, changedPaths).map((selection) => selectionWithExclusions(project, selection));
  const batches = integrationTestBatches(project, selections, pinned.command || '', timeoutMilliseconds, fileThreshold);
  const failures = executeImportBatches(project, batches, pinned, environment);
  const importingTestSummary = { selectedFiles: selections.reduce((total, selection) => total + selection.files.length, 0), durationMilliseconds: Date.now() - started, timeoutMilliseconds, exclusionReason: 'Wall-clock performance and benchmark files are excluded from selected-file batches; full gates own their exclusions.' };
  if (pinned.logPath) fs.appendFileSync(pinned.logPath, '\nImport-walk gate: ' + JSON.stringify({ ...importingTestSummary, selections, batches }) + '\n');
  return { ...(failures[0] ?? pinned), integrationTests: selections, importingTestResults: failures, importingTestSummary };
}

function guidancePath(file: string): boolean {
  return /^(?:docs\/|plugins\/[^/]+\/(?:skills|docs)\/).*\.md$/.test(file.replaceAll('\\', '/'));
}

export function selectIntegrationTests(project: string, changedPaths: string[]): IntegrationTestSelection[] {
  const pluginNames = changedPaths.map((file) => /^plugins\/([^/]+)\//.exec(file.replaceAll('\\', '/'))?.[1]).filter((name): name is string => name !== undefined);
  if (changedPaths.some((file) => /^docs\/.*\.md$/.test(file))) pluginNames.push('sidequest');
  return Array.from(new Set(pluginNames), (plugin) => pluginSelection(project, plugin, changedPaths));
}

// A delivery records where its merged-tree gate is in a per-ticket file, so pulse can answer "is it
// still running, which file, and how did it end" from any process, including after the MCP client that
// started it gave up waiting (SQ-3884).
export type IntegrationProgressState = 'running' | 'delivered' | 'rolled_back' | 'rollback_failed' | 'refused';

export interface IntegrationProgress {
  state: IntegrationProgressState;
  refs: string;
  logPath: string | null;
  phase: string;
  currentFile: string | null;
  fileIndex: number | null;
  fileCount: number | null;
  startedAt: string;
  updatedAt: string;
  pid: number;
  reason?: string;
}

export interface DeliveryOutcome {
  ok?: boolean;
  reason?: unknown;
}

type IntegrationProgressListener = (progress: IntegrationProgress) => void;

const progressListeners = new Set<IntegrationProgressListener>();
let activeProgress: { files: string[]; record: IntegrationProgress } | null = null;

export function integrationProgressPath(boardDirectory: string, ref: string): string {
  return path.join(boardDirectory, 'integrations', `${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

export function onIntegrationProgress(listener: IntegrationProgressListener): () => void {
  progressListeners.add(listener);
  return () => { progressListeners.delete(listener); };
}

// Progress is advisory: a full disk or a reader holding the file open must never fail the delivery.
function writeProgressFile(file: string, record: IntegrationProgress): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, file);
  } catch {
    try { fs.writeFileSync(file, JSON.stringify(record)); } catch { /* advisory */ }
  }
}

function publishProgress(): void {
  if (!activeProgress) return;
  const { files, record } = activeProgress;
  for (const file of files) writeProgressFile(file, record);
  for (const listener of progressListeners) {
    try { listener(record); } catch { /* a listener never fails the delivery */ }
  }
}

export function beginIntegrationProgress(files: string[], refs: string, logPath: string | null): void {
  const now = new Date().toISOString();
  activeProgress = {
    files,
    record: { state: 'running', refs, logPath, phase: 'merging', currentFile: null, fileIndex: null, fileCount: null, startedAt: now, updatedAt: now, pid: process.pid },
  };
  publishProgress();
}

export function reportIntegrationProgress(phase: string, currentFile: string | null = null, position: { index: number; count: number } | null = null): void {
  if (!activeProgress) return;
  activeProgress.record = {
    ...activeProgress.record,
    phase,
    currentFile,
    fileIndex: position ? position.index : null,
    fileCount: position ? position.count : null,
    updatedAt: new Date().toISOString(),
  };
  publishProgress();
}

export function integrationProgressSummary(progress: IntegrationProgress): string {
  const file = progress.currentFile ? ` ${progress.currentFile}` : '';
  const position = progress.fileIndex ? ` (${progress.fileIndex}/${progress.fileCount})` : '';
  return `integrate ${progress.refs}: ${progress.phase}${file}${position}`;
}

export function deliveryOutcomeState(outcome: DeliveryOutcome): IntegrationProgressState {
  if (outcome.ok) return 'delivered';
  const reason = String(outcome.reason || '');
  if (reason.endsWith('rollback_failed')) return 'rollback_failed';
  return /_(?:post_merge|wave_delivery)$/.test(reason) ? 'rolled_back' : 'refused';
}

export function finishIntegrationProgress(outcome: DeliveryOutcome): void {
  if (!activeProgress) return;
  const state = deliveryOutcomeState(outcome);
  activeProgress.record = {
    ...activeProgress.record,
    state,
    phase: 'finished',
    currentFile: null,
    fileIndex: null,
    fileCount: null,
    updatedAt: new Date().toISOString(),
    ...(state === 'delivered' ? {} : { reason: String(outcome.reason || 'unknown') }),
  };
  publishProgress();
  activeProgress = null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isIntegrationProgress(value: unknown): value is IntegrationProgress {
  return typeof value === 'object' && value !== null && 'state' in value && 'refs' in value && 'pid' in value;
}

// A running record whose writer is gone was cut short (the process was killed mid-gate); saying so
// beats showing it as running forever.
export function readIntegrationProgress(file: string): (IntegrationProgress & { writerAlive?: boolean }) | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isIntegrationProgress(parsed)) return null;
  return parsed.state === 'running' ? { ...parsed, writerAlive: processAlive(Number(parsed.pid)) } : parsed;
}
