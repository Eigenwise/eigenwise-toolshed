import { createRequire } from 'node:module';
import type { SemanticEngineRuntime } from '../../runtime-contract.js';

const internalChunkId = 223;
const vendorChunkId = 474;
const analyzerServiceModuleId = 2439;
const programModuleId = 5668;
const analyzerServiceExecutorModuleId = 8779;
const parseTreeWalkerModuleId = 9401;
const uriModuleId = 3252;

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

export interface PyrightAdapter {
  readonly AnalyzerService: new (...arguments_: unknown[]) => unknown;
  readonly AnalyzerServiceExecutor: Record<string, unknown>;
  readonly ParseTreeWalker: new (...arguments_: unknown[]) => unknown;
  readonly Program: new (...arguments_: unknown[]) => unknown;
  readonly Uri: Record<string, unknown>;
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
  const executor = require(analyzerServiceExecutorModuleId);
  const program = require(programModuleId);
  const walker = require(parseTreeWalkerModuleId);
  const uri = require(uriModuleId);
  return {
    AnalyzerService: requiredExport<PyrightAdapter['AnalyzerService']>(analyzerService, analyzerServiceModuleId, 'AnalyzerService'),
    AnalyzerServiceExecutor: requiredExport<PyrightAdapter['AnalyzerServiceExecutor']>(executor, analyzerServiceExecutorModuleId, 'AnalyzerServiceExecutor'),
    ParseTreeWalker: requiredExport<PyrightAdapter['ParseTreeWalker']>(walker, parseTreeWalkerModuleId, 'ParseTreeWalker'),
    Program: requiredExport<PyrightAdapter['Program']>(program, programModuleId, 'Program'),
    Uri: requiredExport<PyrightAdapter['Uri']>(uri, uriModuleId, 'Uri'),
  };
}
