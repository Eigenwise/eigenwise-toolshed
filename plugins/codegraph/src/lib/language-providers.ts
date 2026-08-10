import { PythonLanguageProvider } from './extractors/python/python.js';
import { TypeScriptLanguageProvider } from './extractors/typescript.js';
import { PyrightRuntimeAcquirer } from './languages/python/runtime.js';
import { SemanticLanguageProviderRegistry } from './runtime-contract.js';
import { TypeScriptRuntimeAcquirer } from './runtime.js';

// Every entrypoint builds its registry here. Assembling the list at the
// entrypoint instead shipped Python as dead code in 0.2.0: the provider, its
// runtime, and 102 passing tests all existed, and `bin/codegraph-mcp.ts` never
// named it, so a Python project indexed to an empty snapshot with no error.
// A new language is registered once, in this function, and
// `language-providers.test.ts` fails until it appears.
export function defaultLanguageProviders(runtimeStateDirectory: string): SemanticLanguageProviderRegistry {
  return new SemanticLanguageProviderRegistry([
    new TypeScriptLanguageProvider(new TypeScriptRuntimeAcquirer({ stateDirectory: runtimeStateDirectory })),
    new PythonLanguageProvider(new PyrightRuntimeAcquirer({ stateDirectory: runtimeStateDirectory })),
  ]);
}
