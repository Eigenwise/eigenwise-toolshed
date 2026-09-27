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
var credential_projection_exports = {};
__export(credential_projection_exports, {
  redactDispatchCredentials: () => redactDispatchCredentials
});
module.exports = __toCommonJS(credential_projection_exports);
function redactDispatchCredentials(value) {
  if (Array.isArray(value)) return value.map(redactDispatchCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["dispatchNonce", "tokenFile", "token"].includes(key)).map(([key, entry]) => [key, redactDispatchCredentials(entry)]));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  redactDispatchCredentials
});
