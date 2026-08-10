import { createRequire } from 'node:module';
import type { SemanticEngineRuntime } from '../../runtime-contract.js';

const internalChunkId = 223;
const vendorChunkId = 474;
const analyzerServiceModuleId = 2439;
const tomlModuleId = 1294;
const programModuleId = 5668;
const analyzerServiceExecutorModuleId = 8779;
const parseTreeWalkerModuleId = 9401;
const uriModuleId = 3252;
const serviceProviderModuleId = 4471;
const nodeFileSystemModuleId = 1784;
const pyrightFileSystemModuleId = 2965;

interface WebpackModule {
  exports: Record<string, unknown>;
}

type WebpackRequire = ((moduleId: number) => Record<string, unknown>) & {
  d(exports: object, definitions: Record<string, () => unknown>): void;
  g: typeof globalThis;
  n(moduleValue: unknown): (() => unknown) & { a: () => unknown };
  o(value: object, key: PropertyKey): boolean;
  r(exports: Record<string, unknown>): void;
};

type WebpackFactory = (module: WebpackModule, exports: Record<string, unknown>, require: WebpackRequire) => void;

interface WebpackChunk {
  readonly ids: readonly number[];
  readonly modules: Readonly<Record<string, WebpackFactory>>;
}

export interface PyrightSemanticDeclaration {
  readonly name: string;
  readonly kind: 'class' | 'function' | 'method' | 'property' | 'variable' | 'alias';
  readonly start: number;
  readonly length: number;
  readonly targetPath: string | null;
  readonly targetName: string | null;
  readonly baseTargets: readonly PyrightSemanticTargetResult[];
  readonly uncertain: boolean;
  readonly children: readonly PyrightSemanticDeclaration[];
}

export interface PyrightSemanticTarget {
  readonly path: string;
  readonly name: string;
  readonly start: number;
}

export interface PyrightSemanticCall {
  readonly start: number;
  readonly length: number;
  readonly ownerStart: number | null;
  readonly target: PyrightSemanticTarget | null;
  readonly uncertainty: 'unresolved' | 'dynamic' | 'ambiguous' | null;
}

export interface PyrightSemanticReference {
  readonly start: number;
  readonly length: number;
  readonly ownerStart: number | null;
  readonly target: PyrightSemanticTarget | null;
  readonly uncertainty: 'unresolved' | 'ambiguous' | null;
}

export interface PyrightSemanticFile {
  readonly absolutePath: string;
  readonly content: string;
  readonly moduleName: string;
  readonly declarations: readonly PyrightSemanticDeclaration[];
  readonly calls: readonly PyrightSemanticCall[];
  readonly references: readonly PyrightSemanticReference[];
}

export interface PyrightAnalysisService {
  analyze(): boolean;
  semanticFiles(): readonly PyrightSemanticFile[];
  dispose(): void;
}

export interface PyrightAdapter {
  readonly AnalyzerService: new (...arguments_: unknown[]) => unknown;
  readonly AnalyzerServiceExecutor: Record<string, unknown>;
  readonly ParseTreeWalker: new (...arguments_: unknown[]) => unknown;
  readonly Program: new (...arguments_: unknown[]) => unknown;
  readonly Uri: UriModule;
  createAnalysisService(projectRoot: string, configFile: string | null): PyrightAnalysisService;
}

export class PyrightCompatibilityError extends Error {
  constructor(message: string) {
    super(`Pyright 1.1.411 compatibility error: ${message}`);
    this.name = 'PyrightCompatibilityError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function webpackChunk(value: unknown, expectedId: number): WebpackChunk {
  const candidate = record(record(value)?.default ?? value);
  const ids = candidate?.ids;
  const modules = candidate?.modules;
  const moduleRecord = record(modules);
  if (!Array.isArray(ids) || !ids.includes(expectedId) || moduleRecord === undefined) {
    throw new PyrightCompatibilityError(`webpack chunk ${expectedId} does not have the pinned registry shape`);
  }
  if (!Object.values(moduleRecord).every((factory) => typeof factory === 'function')) {
    throw new PyrightCompatibilityError(`webpack chunk ${expectedId} contains a non-callable module factory`);
  }
  return { ids, modules: modules as Readonly<Record<string, WebpackFactory>> };
}

function requiredExport<T>(moduleValue: Record<string, unknown>, moduleId: number, name: string): T {
  const value = moduleValue[name];
  if (value === undefined) throw new PyrightCompatibilityError(`module ${moduleId} does not export ${name}`);
  return value as T;
}

interface ServiceProviderModule {
  createServiceProvider(...services: unknown[]): unknown;
}

interface TomlModule {
  ensureTomlModuleLoaded(): Promise<void>;
}

interface UriModule {
  file(path: string, serviceProvider?: unknown): unknown;
}

interface NodeFileSystemModule {
  readonly RealTempFile: new () => unknown;
  readonly WorkspaceFileWatcherProvider: new (console: unknown) => unknown;
  createFromRealFileSystem(tempFile: unknown, console: unknown, watcher: unknown): unknown;
}

interface PyrightFileSystemModule {
  readonly PyrightFileSystem: new (fileSystem: unknown) => unknown;
}

interface PyrightUri {
  getFilePath(): string;
}

interface PyrightSymbol {
  getDeclarations(): readonly unknown[];
}

interface PyrightSourceFile {
  getFileContent(): string;
  getModuleName(): string;
  getParserOutput(): unknown;
  getUri(): PyrightUri;
}

interface PyrightSourceFileInfo {
  readonly sourceFile: PyrightSourceFile;
}

interface PyrightDeclarationInfo {
  readonly decls: readonly unknown[];
}

interface PyrightEvaluator {
  getDeclInfoForNameNode(node: unknown): PyrightDeclarationInfo;
  getTypeOfClass(node: unknown): unknown;
  resolveAliasDeclaration(declaration: unknown): unknown;
}

interface PyrightProgram {
  readonly evaluator: PyrightEvaluator;
  getSourceFileInfoList(): readonly PyrightSourceFileInfo[];
}

interface AnalyzerServiceInstance {
  readonly test_program: PyrightProgram & { analyze(): boolean };
  setOptions(options: Record<string, unknown>): void;
  enumerateSourceFiles(): boolean;
  dispose(): void;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function nodeName(node: unknown): string | null {
  return stringValue(record(record(node)?.d)?.value);
}

function classBaseTargets(node: Record<string, unknown>, evaluator: PyrightEvaluator): PyrightSemanticTargetResult[] {
  const classResult = record(evaluator.getTypeOfClass(node));
  const classType = record(classResult?.classType);
  const baseClasses = record(classType?.shared)?.baseClasses;
  if (!Array.isArray(baseClasses)) return [];
  return baseClasses.flatMap((baseClass) => {
    const shared = record(record(baseClass)?.shared);
    if (shared?.fullName === 'builtins.object') return [];
    const declaration = shared?.declaration;
    return declaration === undefined ? [{ target: null, uncertainty: 'unresolved' as const }] : [resolvedDeclarationTarget(evaluator, [declaration])];
  });
}

interface PyrightSemanticTargetResult {
  readonly target: PyrightSemanticTarget | null;
  readonly uncertainty: 'unresolved' | 'ambiguous' | null;
}

function resolvedDeclarationTarget(evaluator: PyrightEvaluator, declarations: readonly unknown[]): PyrightSemanticTargetResult {
  if (declarations.length !== 1) return { target: null, uncertainty: declarations.length === 0 ? 'unresolved' : 'ambiguous' };
  const resolved = record(evaluator.resolveAliasDeclaration(declarations[0]));
  const uri = record(resolved?.uri) as unknown as PyrightUri | undefined;
  const declarationNode = record(resolved?.node);
  const details = record(declarationNode?.d);
  const name = stringValue(resolved?.symbolName) ?? nodeName(details?.name) ?? nodeName(details?.leftExpr);
  if (uri === undefined || declarationNode === undefined || name === null) return { target: null, uncertainty: 'unresolved' };
  return { target: { path: uri.getFilePath(), name, start: numberValue(declarationNode.start) }, uncertainty: null };
}

function declarationTarget(evaluator: PyrightEvaluator, node: unknown): PyrightSemanticTargetResult {
  return resolvedDeclarationTarget(evaluator, evaluator.getDeclInfoForNameNode(node).decls);
}

function declarationOwnerStart(node: Record<string, unknown>): number | null {
  let current = record(node.parent);
  while (current !== undefined) {
    if (current.nodeType === 10 || current.nodeType === 31) return numberValue(current.start);
    current = record(current.parent);
  }
  return null;
}

function isDeclarationName(node: Record<string, unknown>): boolean {
  const parent = record(node.parent);
  const details = record(parent?.d);
  return (parent?.nodeType === 10 || parent?.nodeType === 31) && details?.name === node;
}

function expressionName(node: unknown): string | null {
  return nodeName(node) ?? nodeName(record(node)?.d);
}

function callUncertainty(node: Record<string, unknown>, target: PyrightSemanticTargetResult): PyrightSemanticCall['uncertainty'] {
  if (target.uncertainty !== null) return target.uncertainty;
  const expression = record(node.d)?.leftExpr;
  const name = expressionName(expression);
  if (name === '__import__' || name === 'import_module' || name === 'getattr') return 'dynamic';
  return name === null ? 'dynamic' : 'unresolved';
}

function hasUncertainDecorator(decorators: unknown): boolean {
  if (!Array.isArray(decorators)) return false;
  return decorators.some((decorator) => {
    const expression = record(record(decorator)?.d)?.expr;
    const name = expressionName(expression);
    return name !== 'property' && name !== 'classmethod' && name !== 'staticmethod';
  });
}

function hasMetaclass(node: Record<string, unknown>): boolean {
  const arguments_ = record(node.d)?.arguments;
  return Array.isArray(arguments_) && arguments_.some((argument) => expressionName(record(argument)?.d) === 'metaclass');
}

function semanticRelationships(
  node: unknown,
  evaluator: PyrightEvaluator,
  calls: PyrightSemanticCall[],
  references: PyrightSemanticReference[],
  seen = new Set<object>(),
): void {
  const candidate = record(node);
  if (candidate === undefined || seen.has(candidate)) return;
  seen.add(candidate);
  const details = record(candidate.d);
  const ownerStart = declarationOwnerStart(candidate);
  if (candidate.nodeType === 38 && !isDeclarationName(candidate)) {
    const target = declarationTarget(evaluator, candidate);
    references.push({ start: numberValue(candidate.start), length: numberValue(candidate.length), ownerStart, target: target.target, uncertainty: target.uncertainty });
  }
  if (Array.isArray(details?.args) && record(details.leftExpr) !== undefined) {
    const expression = record(details.leftExpr);
    const target = declarationTarget(evaluator, expression === undefined ? details.leftExpr : expression.d === undefined ? expression : record(expression.d)?.member ?? expression);
    calls.push({ start: numberValue(candidate.start), length: numberValue(candidate.length), ownerStart, target: target.target, uncertainty: callUncertainty(candidate, target) });
  }
  for (const value of Object.values(details ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) semanticRelationships(item, evaluator, calls, references, seen);
    } else semanticRelationships(value, evaluator, calls, references, seen);
  }
}

function declarationKind(declaration: Record<string, unknown>, node: Record<string, unknown>): PyrightSemanticDeclaration['kind'] | null {
  if (declaration.type === 8) return 'alias';
  if (node.nodeType === 10) return 'class';
  if (node.nodeType === 31) {
    const decorators = record(node.d)?.decorators;
    const isProperty = Array.isArray(decorators) && decorators.some((decorator) => {
      const expression = record(record(decorator)?.d)?.expr;
      return stringValue(record(record(expression)?.d)?.value) === 'property';
    });
    return isProperty ? 'property' : declaration.isMethod === true ? 'method' : 'function';
  }
  return declaration.type === 1 ? 'variable' : null;
}

function semanticDeclarations(symbolTable: unknown, evaluator: PyrightEvaluator, seenScopes = new Set<object>()): PyrightSemanticDeclaration[] {
  if (!(symbolTable instanceof Map) || seenScopes.has(symbolTable)) return [];
  seenScopes.add(symbolTable);
  const declarations: PyrightSemanticDeclaration[] = [];
  for (const [name, symbol] of symbolTable) {
    if (typeof name !== 'string' || !record(symbol)) continue;
    if (name === '__doc__' || name === '__module__' || name === '__qualname__') continue;
    const symbolRecord = symbol as unknown as PyrightSymbol;
    let emittedVariable = false;
    for (const declarationValue of symbolRecord.getDeclarations()) {
      const declaration = record(declarationValue);
      const node = record(declaration?.node);
      if (declaration === undefined || node === undefined) continue;
      const kind = declarationKind(declaration, node);
      if (kind === null || (kind === 'variable' && emittedVariable)) continue;
      const uri = record(declaration.uri) as unknown as PyrightUri | undefined;
      const scope = record(node.a)?.scope;
      declarations.push({
        name,
        kind,
        start: numberValue(node.start),
        length: numberValue(node.length),
        targetPath: uri?.getFilePath() ?? null,
        targetName: stringValue(declaration.symbolName),
        baseTargets: kind === 'class' ? classBaseTargets(node, evaluator) : [],
        uncertain: (kind === 'class' && hasMetaclass(node)) || (kind !== 'class' && hasUncertainDecorator(record(node.d)?.decorators)),
        children: kind === 'class' ? semanticDeclarations(record(scope)?.symbolTable, evaluator, seenScopes) : [],
      });
      emittedVariable ||= kind === 'variable';
    }
  }
  return declarations;
}

function semanticFiles(program: PyrightProgram): PyrightSemanticFile[] {
  return program.getSourceFileInfoList().map(({ sourceFile }) => {
    const parseOutput = record(sourceFile.getParserOutput());
    const parseTree = record(parseOutput?.parseTree);
    const rootScope = record(record(parseTree?.a)?.scope);
    const calls: PyrightSemanticCall[] = [];
    const references: PyrightSemanticReference[] = [];
    semanticRelationships(parseTree, program.evaluator, calls, references);
    return {
      absolutePath: sourceFile.getUri().getFilePath(),
      content: sourceFile.getFileContent(),
      moduleName: sourceFile.getModuleName(),
      declarations: semanticDeclarations(rootScope?.symbolTable, program.evaluator),
      calls,
      references,
    };
  });
}

function createAnalysisService(
  AnalyzerService: new (...arguments_: unknown[]) => unknown,
  serviceProvider: ServiceProviderModule,
  Uri: UriModule,
  nodeFileSystem: NodeFileSystemModule,
  pyrightFileSystem: PyrightFileSystemModule,
  projectRoot: string,
  configFile: string | null,
): PyrightAnalysisService {
  const console = { log: (_message: string) => undefined, info: (_message: string) => undefined, warn: (_message: string) => undefined, error: (_message: string) => undefined };
  const tempFile = new nodeFileSystem.RealTempFile();
  const fileSystem = new pyrightFileSystem.PyrightFileSystem(nodeFileSystem.createFromRealFileSystem(
    tempFile,
    console,
    new nodeFileSystem.WorkspaceFileWatcherProvider(console),
  ));
  const provider = serviceProvider.createServiceProvider(fileSystem, console, tempFile);
  const service = new AnalyzerService('codegraph', provider, {});
  if (typeof service !== 'object' || service === null || !('test_program' in service) || !('dispose' in service) || !('setOptions' in service) || !('enumerateSourceFiles' in service)) {
    throw new PyrightCompatibilityError('AnalyzerService does not expose the pinned analysis program');
  }
  const candidate = service as AnalyzerServiceInstance;
  candidate.setOptions({
    executionRoot: projectRoot,
    configFilePath: configFile ?? undefined,
    configSettings: {
      includeFileSpecs: [],
      excludeFileSpecs: [],
      ignoreFileSpecs: [],
      diagnosticSeverityOverrides: {},
      diagnosticBooleanOverrides: {},
    },
    languageServerSettings: {},
  });
  while (!candidate.enumerateSourceFiles()) undefined;
  return {
    analyze(): boolean {
      return candidate.test_program.analyze();
    },
    semanticFiles(): readonly PyrightSemanticFile[] {
      return semanticFiles(candidate.test_program);
    },
    dispose(): void {
      candidate.dispose();
    },
  };
}

function nodeModuleFactory(specifier: string): WebpackFactory {
  const nodeRequire = createRequire(__filename);
  return (module) => {
    module.exports = nodeRequire(specifier) as Record<string, unknown>;
  };
}

function externalFactories(): Record<number, WebpackFactory> {
  return {
    8240: nodeModuleFactory('fsevents'),
    5317: nodeModuleFactory('node:child_process'),
    6982: nodeModuleFactory('node:crypto'),
    4434: nodeModuleFactory('node:events'),
    9896: nodeModuleFactory('node:fs'),
    857: nodeModuleFactory('node:os'),
    6928: nodeModuleFactory('node:path'),
    932: nodeModuleFactory('node:process'),
    3785: nodeModuleFactory('node:readline'),
    2203: nodeModuleFactory('node:stream'),
    2018: nodeModuleFactory('node:tty'),
    7016: nodeModuleFactory('node:url'),
    9023: nodeModuleFactory('node:util'),
    1493: nodeModuleFactory('node:v8'),
    8167: nodeModuleFactory('node:worker_threads'),
    3106: nodeModuleFactory('node:zlib'),
  };
}

function webpackLoader(chunks: readonly WebpackChunk[]): WebpackRequire {
  const factories = new Map<number, WebpackFactory>();
  const cache = new Map<number, WebpackModule>();
  for (const [moduleId, factory] of Object.entries(externalFactories())) factories.set(Number(moduleId), factory);
  for (const chunk of chunks) {
    for (const [moduleId, factory] of Object.entries(chunk.modules)) factories.set(Number(moduleId), factory);
  }

  const load = ((moduleId: number): Record<string, unknown> => {
    const cached = cache.get(moduleId);
    if (cached !== undefined) return cached.exports;
    const factory = factories.get(moduleId);
    if (factory === undefined) throw new PyrightCompatibilityError(`required webpack module ${moduleId} is absent`);
    const module = { exports: {} };
    cache.set(moduleId, module);
    try {
      factory(module, module.exports, load);
      return module.exports;
    } catch (error: unknown) {
      cache.delete(moduleId);
      const detail = error instanceof Error ? error.message : String(error);
      throw new PyrightCompatibilityError(`required webpack module ${moduleId} could not execute: ${detail}`);
    }
  }) as WebpackRequire;

  load.d = (exports, definitions) => {
    for (const [key, definition] of Object.entries(definitions)) {
      if (!load.o(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: definition });
    }
  };
  load.g = globalThis;
  load.n = (moduleValue) => {
    const moduleRecord = record(moduleValue);
    const getter = moduleRecord?.__esModule === true ? () => moduleRecord.default : () => moduleValue;
    const getterWithDefault = Object.assign(getter, { a: getter });
    load.d(getterWithDefault, { a: getter });
    return getterWithDefault;
  };
  load.o = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  load.r = (exports) => {
    Object.defineProperty(exports, '__esModule', { value: true });
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  };
  return load;
}

export async function loadPyrightAdapter(runtime: SemanticEngineRuntime): Promise<PyrightAdapter> {
  if (runtime.id !== 'pyright' || runtime.version !== '1.1.411') {
    throw new PyrightCompatibilityError(`expected pyright@1.1.411, received ${runtime.id}@${runtime.version}`);
  }
  const [vendor, internal] = await Promise.all([
    runtime.importModule('pyright/dist/vendor.js'),
    runtime.importModule('pyright/dist/pyright-internal.js'),
  ]);
  const require = webpackLoader([webpackChunk(vendor, vendorChunkId), webpackChunk(internal, internalChunkId)]);
  const analyzerService = require(analyzerServiceModuleId);
  const toml = require(tomlModuleId);
  const executor = require(analyzerServiceExecutorModuleId);
  const program = require(programModuleId);
  const walker = require(parseTreeWalkerModuleId);
  const uri = require(uriModuleId);
  const serviceProvider = require(serviceProviderModuleId);
  const nodeFileSystem = require(nodeFileSystemModuleId);
  const pyrightFileSystem = require(pyrightFileSystemModuleId);
  await requiredExport<TomlModule['ensureTomlModuleLoaded']>(toml, tomlModuleId, 'ensureTomlModuleLoaded')();
  const AnalyzerService = requiredExport<PyrightAdapter['AnalyzerService']>(analyzerService, analyzerServiceModuleId, 'AnalyzerService');
  const Uri = requiredExport<UriModule>(uri, uriModuleId, 'Uri');
  return {
    AnalyzerService,
    AnalyzerServiceExecutor: requiredExport<PyrightAdapter['AnalyzerServiceExecutor']>(executor, analyzerServiceExecutorModuleId, 'AnalyzerServiceExecutor'),
    ParseTreeWalker: requiredExport<PyrightAdapter['ParseTreeWalker']>(walker, parseTreeWalkerModuleId, 'ParseTreeWalker'),
    Program: requiredExport<PyrightAdapter['Program']>(program, programModuleId, 'Program'),
    Uri,
    createAnalysisService(projectRoot, configFile) {
      return createAnalysisService(
        AnalyzerService,
        { createServiceProvider: requiredExport<ServiceProviderModule['createServiceProvider']>(serviceProvider, serviceProviderModuleId, 'createServiceProvider') },
        Uri,
        {
          RealTempFile: requiredExport<NodeFileSystemModule['RealTempFile']>(nodeFileSystem, nodeFileSystemModuleId, 'RealTempFile'),
          WorkspaceFileWatcherProvider: requiredExport<NodeFileSystemModule['WorkspaceFileWatcherProvider']>(nodeFileSystem, nodeFileSystemModuleId, 'WorkspaceFileWatcherProvider'),
          createFromRealFileSystem: requiredExport<NodeFileSystemModule['createFromRealFileSystem']>(nodeFileSystem, nodeFileSystemModuleId, 'createFromRealFileSystem'),
        },
        { PyrightFileSystem: requiredExport<PyrightFileSystemModule['PyrightFileSystem']>(pyrightFileSystem, pyrightFileSystemModuleId, 'PyrightFileSystem') },
        projectRoot,
        configFile,
      );
    },
  };
}
