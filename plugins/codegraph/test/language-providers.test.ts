import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { defaultLanguageProviders } from '../src/lib/language-providers.ts';
import type { SemanticLanguageProviderRegistry } from '../src/lib/runtime-contract.ts';

const packageRoot = process.cwd();
const stateDirectory = path.join(packageRoot, 'test-state');
const shippedLanguages = ['javascript', 'python', 'typescript'];

const languagesOf = (providers: SemanticLanguageProviderRegistry): string[] =>
  [...providers.providers.flatMap((provider) => provider.languages)].sort();

test('every shipped language provider is registered', () => {
  assert.deepEqual(languagesOf(defaultLanguageProviders(stateDirectory)), shippedLanguages);
});

// Python shipped complete and unreachable in 0.2.0: the provider, its runtime,
// and the whole suite were green while the compiled entrypoint built its own
// registry and never named Python. Asserting on src alone cannot see that, so
// this loads the compiled factory the plugin actually publishes.
test('the compiled factory registers the same languages as the source', () => {
  const requireCompiled = createRequire(path.join(packageRoot, 'package.json'));
  const compiled = requireCompiled(path.join(packageRoot, 'lib', 'language-providers.js')) as {
    defaultLanguageProviders(directory: string): SemanticLanguageProviderRegistry;
  };
  assert.deepEqual(languagesOf(compiled.defaultLanguageProviders(stateDirectory)), shippedLanguages);
});
