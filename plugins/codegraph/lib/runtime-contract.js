"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var runtime_contract_exports = {};
__export(runtime_contract_exports, {
  SemanticLanguageProviderRegistry: () => SemanticLanguageProviderRegistry,
  isSemanticEngineRuntime: () => isSemanticEngineRuntime,
  runtimeEngineIdentities: () => runtimeEngineIdentities,
  snapshotEngineIdentity: () => snapshotEngineIdentity
});
module.exports = __toCommonJS(runtime_contract_exports);
function isSemanticEngineRuntime(runtime) {
  return "importModule" in runtime;
}
function runtimeEngineIdentities(runtime) {
  return runtime.engines ?? [{ id: runtime.engineId, version: runtime.engineVersion }];
}
class SemanticLanguageProviderRegistry {
  providers;
  constructor(providers) {
    const orderedProviders = [...providers].sort((left, right) => left.id.localeCompare(right.id));
    for (let index = 1; index < orderedProviders.length; index += 1) {
      if (orderedProviders[index - 1].id === orderedProviders[index].id) {
        throw new Error(`duplicate semantic language provider: ${orderedProviders[index].id}`);
      }
    }
    this.providers = orderedProviders;
  }
  freshnessContributors() {
    return this.providers.map((provider) => provider.freshness);
  }
  async acquireRuntime() {
    const acquiredProviders = await Promise.all(this.providers.map(async (provider) => ({
      provider,
      runtime: await provider.acquireEngine()
    })));
    const engines = acquiredProviders.map(({ runtime }) => ({ id: runtime.id, version: runtime.version })).sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
    const extractors = acquiredProviders.sort(({ provider: left }, { provider: right }) => left.id.localeCompare(right.id)).map(({ provider, runtime }) => provider.createExtractor(runtime));
    const identity = snapshotEngineIdentity(engines);
    return {
      engines,
      engineId: identity.id,
      engineVersion: identity.version,
      extractors,
      dependencyEnvironmentFor: async (project) => {
        const provider = this.providers.find((candidate) => candidate.languages.includes(project.language));
        return provider === void 0 ? { state: "absent", absolutePaths: [] } : provider.dependencyEnvironment.discover(project);
      }
    };
  }
}
function snapshotEngineIdentity(engines) {
  const orderedEngines = [...engines].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  if (orderedEngines.length === 1) return orderedEngines[0];
  return { id: "codegraph-engines", version: JSON.stringify(orderedEngines) };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SemanticLanguageProviderRegistry,
  isSemanticEngineRuntime,
  runtimeEngineIdentities,
  snapshotEngineIdentity
});
