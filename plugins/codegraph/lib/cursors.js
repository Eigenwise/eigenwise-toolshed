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
var cursors_exports = {};
__export(cursors_exports, {
  decodeCursor: () => decodeCursor,
  encodeCursor: () => encodeCursor,
  normalizedQueryHash: () => normalizedQueryHash
});
module.exports = __toCommonJS(cursors_exports);
var import_node_crypto = require("node:crypto");
function normalizedQueryHash(query) {
  return (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(query)).digest("hex");
}
function encodeCursor(snapshotId, query, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("cursor offset must be a non-negative integer");
  const cursor = { version: 1, snapshotId, queryHash: normalizedQueryHash(query), offset };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodeCursor(cursor, snapshotId, query) {
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid graph cursor");
  }
  if (typeof value !== "object" || value === null) throw new Error("invalid graph cursor");
  const candidate = value;
  const offset = candidate.offset;
  if (candidate.version !== 1 || candidate.snapshotId !== snapshotId || candidate.queryHash !== normalizedQueryHash(query) || !Number.isSafeInteger(offset) || offset === void 0 || offset < 0) {
    throw new Error("graph cursor does not match this snapshot and query");
  }
  return offset;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decodeCursor,
  encodeCursor,
  normalizedQueryHash
});
