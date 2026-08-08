"use strict";
const crypto = require("node:crypto");
const CONTEXT_PROJECTION_VERSION = 1;
const DEFAULT_RECIPIENT_PROFILES = Object.freeze({
  executor: Object.freeze({ id: "executor", budgetBytes: 64 * 1024 }),
  orchestrator: Object.freeze({ id: "orchestrator", budgetBytes: 128 * 1024 }),
  hook: Object.freeze({ id: "hook", budgetBytes: 8 * 1024 }),
  mcp: Object.freeze({ id: "mcp", budgetBytes: 16 * 1024 })
});
const RECIPIENT_PROFILES = DEFAULT_RECIPIENT_PROFILES;
function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}
function utf8Excerpt(value, maxBytes) {
  const source = String(value ?? "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (utf8ByteLength(source) <= limit) return { text: source, bytes: utf8ByteLength(source), truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of source) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > limit) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes, truncated: true };
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}
function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function normalizedWatermarks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, String(value[key])]));
}
function normalizedRetrieval(value, itemId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`context projection item "${itemId}" needs a retrieval instruction before it can be omitted.`);
  }
  const tool = String(value.tool || "").trim();
  if (!tool) throw new Error(`context projection item "${itemId}" retrieval instruction needs an MCP tool name.`);
  const argumentsValue = value.arguments ?? value.args;
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error(`context projection item "${itemId}" retrieval instruction needs MCP tool arguments.`);
  }
  return { tool, arguments: canonicalValue(argumentsValue) };
}
function normalizedItem(value, index) {
  const id = String(value?.id ?? "").trim();
  if (!id) throw new Error("context projection items need stable ids.");
  const body = String(value.body ?? value.text ?? value.content ?? "");
  const priority = Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0;
  const order = Number.isFinite(Number(value.order)) ? Number(value.order) : 0;
  return {
    id,
    kind: String(value.kind || "context"),
    body,
    priority,
    order,
    watermark: value.watermark == null ? null : String(value.watermark),
    retrieval: normalizedRetrieval(value.retrieval, id),
    sourceIndex: index
  };
}
function stableItems(items) {
  const ids = /* @__PURE__ */ new Set();
  const normalized = items.map(normalizedItem);
  for (const item of normalized) {
    if (ids.has(item.id)) throw new Error(`context projection item id "${item.id}" is duplicated.`);
    ids.add(item.id);
  }
  return normalized.sort((left, right) => right.priority - left.priority || left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) || left.sourceIndex - right.sourceIndex);
}
function recipientProfile(value) {
  const supplied = typeof value === "string" ? DEFAULT_RECIPIENT_PROFILES[value] : value;
  if (!supplied || typeof supplied !== "object") throw new Error("context projection needs a known recipient profile or explicit profile.");
  const id = String(supplied.id || supplied.recipient || "").trim();
  const budgetBytes = Number(supplied.budgetBytes ?? supplied.maxBytes);
  if (!id) throw new Error("context projection recipient profile needs an id.");
  if (!Number.isInteger(budgetBytes) || budgetBytes < 0) throw new Error(`context projection recipient profile "${id}" needs a non-negative byte budget.`);
  return { id, budgetBytes };
}
function includedItem(item, body, truncated = false) {
  return {
    id: item.id,
    kind: item.kind,
    body,
    bytes: utf8ByteLength(body),
    ...item.watermark == null ? {} : { watermark: item.watermark },
    ...truncated ? { truncated: true, retrieval: item.retrieval } : {}
  };
}
function omission(item, reason, includedBytes = 0) {
  return {
    id: item.id,
    kind: item.kind,
    reason,
    originalBytes: utf8ByteLength(item.body),
    ...reason === "truncated" ? { includedBytes } : {},
    ...item.watermark == null ? {} : { watermark: item.watermark },
    retrieval: item.retrieval
  };
}
function projectionHash(packet) {
  const { hash: _hash, serializedBytes: _serializedBytes, ...hashed } = packet;
  return sha256(hashed);
}
function finalizedPacket(packet) {
  const withHash = Object.assign({}, packet, { hash: projectionHash(packet) });
  let serializedBytes = 0;
  for (; ; ) {
    const next = utf8ByteLength(JSON.stringify(Object.assign({}, withHash, { serializedBytes })));
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  return Object.assign({}, withHash, { serializedBytes });
}
function packetFor(profile, revision, watermarks, selected, omitted) {
  return finalizedPacket({
    version: CONTEXT_PROJECTION_VERSION,
    recipient: profile.id,
    revision,
    budgetBytes: profile.budgetBytes,
    watermarks,
    items: selected,
    omissions: omitted
  });
}
function fits(profile, revision, watermarks, selected, omitted) {
  const packet = packetFor(profile, revision, watermarks, selected, omitted);
  return { packet, fits: packet.serializedBytes <= profile.budgetBytes };
}
function bestTruncatedItem(profile, revision, watermarks, item, selected, omitted) {
  const characters = Array.from(item.body);
  let lower = 0;
  let upper = characters.length;
  let best = null;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    const body = characters.slice(0, count).join("");
    const candidate = includedItem(item, body, true);
    const result = fits(profile, revision, watermarks, [...selected, candidate], [omission(item, "truncated", candidate.bytes), ...omitted]);
    if (result.fits) {
      best = result;
      lower = count + 1;
    } else {
      upper = count - 1;
    }
  }
  return best;
}
function compileContextProjection(input) {
  const profile = recipientProfile(input?.profile ?? input?.recipient);
  const revision = Number.isInteger(Number(input?.revision)) && Number(input?.revision) >= 0 ? Number(input?.revision) : 0;
  const watermarks = normalizedWatermarks(input?.watermarks);
  const candidates = stableItems(Array.isArray(input?.items) ? input.items : []);
  const selected = candidates.map((item) => includedItem(item, item.body));
  const omitted = [];
  while (selected.length) {
    const result2 = fits(profile, revision, watermarks, selected, omitted);
    if (result2.fits) break;
    const removed = candidates[selected.length - 1];
    selected.pop();
    omitted.unshift(omission(removed, "budget"));
  }
  let result = fits(profile, revision, watermarks, selected, omitted);
  if (!result.fits) {
    throw new RangeError(`context projection metadata exceeds the ${profile.budgetBytes}-byte aggregate budget.`);
  }
  if (selected.length < candidates.length) {
    const firstOmitted = candidates[selected.length];
    const remaining = candidates.slice(selected.length + 1).map((item) => omission(item, "budget"));
    const truncated = bestTruncatedItem(profile, revision, watermarks, firstOmitted, selected, remaining);
    if (truncated) result = truncated;
  }
  return result.packet;
}
module.exports = {
  CONTEXT_PROJECTION_VERSION,
  DEFAULT_RECIPIENT_PROFILES,
  RECIPIENT_PROFILES,
  compileContextProjection,
  utf8ByteLength,
  utf8Excerpt
};
