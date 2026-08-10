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
var language_providers_exports = {};
__export(language_providers_exports, {
  defaultLanguageProviders: () => defaultLanguageProviders
});
module.exports = __toCommonJS(language_providers_exports);
var import_python = require("./extractors/python/python.js");
var import_typescript = require("./extractors/typescript.js");
var import_runtime = require("./languages/python/runtime.js");
var import_runtime_contract = require("./runtime-contract.js");
var import_runtime2 = require("./runtime.js");
function defaultLanguageProviders(runtimeStateDirectory) {
  return new import_runtime_contract.SemanticLanguageProviderRegistry([
    new import_typescript.TypeScriptLanguageProvider(new import_runtime2.TypeScriptRuntimeAcquirer({ stateDirectory: runtimeStateDirectory })),
    new import_python.PythonLanguageProvider(new import_runtime.PyrightRuntimeAcquirer({ stateDirectory: runtimeStateDirectory }))
  ]);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  defaultLanguageProviders
});
