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
var prepared_dispatch_exports = {};
__export(prepared_dispatch_exports, {
  canonicalPreparedDispatchExecutor: () => canonicalPreparedDispatchExecutor,
  normalizePreparedDispatch: () => normalizePreparedDispatch
});
module.exports = __toCommonJS(prepared_dispatch_exports);
function canonicalPreparedDispatchExecutor(ticket) {
  const currentExecutor = String(ticket?.dispatch?.executor || "").trim();
  if (currentExecutor) return currentExecutor;
  const legacyExecutor = String(ticket?.dispatchExecutor || "").trim();
  if (legacyExecutor) return legacyExecutor;
  const routedExecutor = String(ticket?.exec?.agent || "").trim();
  return routedExecutor || null;
}
function normalizePreparedDispatch(ticket) {
  if (!ticket || typeof ticket !== "object") return ticket;
  const legacyExecutor = String(ticket.dispatchExecutor || "").trim();
  if (!legacyExecutor) return ticket;
  if (!ticket.dispatch || typeof ticket.dispatch !== "object") {
    ticket.dispatch = { executor: legacyExecutor };
    return ticket;
  }
  if (!String(ticket.dispatch.executor || "").trim()) ticket.dispatch.executor = legacyExecutor;
  return ticket;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  canonicalPreparedDispatchExecutor,
  normalizePreparedDispatch
});
