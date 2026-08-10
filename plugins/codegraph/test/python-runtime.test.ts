import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPyrightAdapter, PyrightCompatibilityError } from '../src/lib/extractors/python/pyright-adapter.ts';

const internalModuleFactories = {
  1294: (module: { exports: Record<string, unknown> }) => { module.exports.ensureTomlModuleLoaded = async () => undefined; },
  1784: (module: { exports: Record<string, unknown> }) => {
    module.exports.RealTempFile = class RealTempFile {};
    module.exports.WorkspaceFileWatcherProvider = class WorkspaceFileWatcherProvider {};
    module.exports.createFromRealFileSystem = () => ({});
  },
  2439: (module: { exports: Record<string, unknown> }) => { module.exports.AnalyzerService = class AnalyzerService {}; },
  2965: (module: { exports: Record<string, unknown> }) => { module.exports.PyrightFileSystem = class PyrightFileSystem {}; },
  3252: (module: { exports: Record<string, unknown> }) => { module.exports.Uri = {}; },
  4471: (module: { exports: Record<string, unknown> }) => { module.exports.createServiceProvider = () => ({}); },
  5668: (module: { exports: Record<string, unknown> }) => { module.exports.Program = class Program {}; },
  8779: (module: { exports: Record<string, unknown> }) => { module.exports.AnalyzerServiceExecutor = {}; },
  9401: (module: { exports: Record<string, unknown> }) => { module.exports.ParseTreeWalker = class ParseTreeWalker {}; },
};

test('loads the pinned Pyright webpack semantic modules', async () => {
  const adapter = await loadPyrightAdapter({
    id: 'pyright',
    version: '1.1.411',
    engineId: 'pyright',
    engineVersion: '1.1.411',
    extractors: [],
    async importModule(specifier: string): Promise<unknown> {
      return specifier.endsWith('vendor.js')
        ? { ids: [474], modules: {} }
        : { ids: [223], modules: internalModuleFactories };
    },
  });
  assert.equal(typeof adapter.AnalyzerService, 'function');
  assert.equal(typeof adapter.Program, 'function');
});

test('rejects a mismatched Pyright engine before loading internals', async () => {
  await assert.rejects(
    loadPyrightAdapter({
      id: 'pyright', version: '1.1.410', engineId: 'pyright', engineVersion: '1.1.410', extractors: [],
      async importModule(): Promise<unknown> { throw new Error('must not import'); },
    }),
    PyrightCompatibilityError,
  );
});
