'use strict';

const crypto = require('node:crypto');

const CONTEXT_PROJECTION_VERSION = 1;
const CONTEXT_HANDLE_VERSION = 1;
const CONTEXT_HANDLE_PREFIX = 'ctx1.';
const CONTEXT_CURSOR_PREFIX = 'ctxc1.';
const DEFAULT_CONTEXT_PAGE_BYTES = 12 * 1024;
const MAX_CONTEXT_PAGE_BYTES = 16 * 1024;
const MIN_CONTEXT_PAGE_BYTES = 4;
const DEFAULT_RECIPIENT_PROFILES = Object.freeze({
  executor: Object.freeze({ id: 'executor' }),
  orchestrator: Object.freeze({ id: 'orchestrator' }),
  hook: Object.freeze({ id: 'hook' }),
  mcp: Object.freeze({ id: 'mcp' }),
});
const RECIPIENT_PROFILES = DEFAULT_RECIPIENT_PROFILES;

type RetrievalInstruction = {
  tool: string;
  arguments: Record<string, unknown>;
};

type ProjectionItem = {
  id: string;
  kind?: string;
  body?: string;
  text?: string;
  content?: string;
  priority?: number;
  order?: number;
  watermark?: string | number | null;
};

type ContextHandleSource = {
  tool: string;
  project: string;
  kind: 'body' | 'rows';
  field: string;
  position: string | number;
  revision: string;
  reason: string;
  selector?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
};

function utf8ByteLength(value?: unknown) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function utf8Excerpt(value?: unknown, maxBytes?: unknown) {
  const source = String(value ?? '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (utf8ByteLength(source) <= limit) return { text: source, bytes: utf8ByteLength(source), truncated: false };
  let text = '';
  let bytes = 0;
  for (const character of source) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > limit) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes, truncated: true };
}

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value: any) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: any) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function contextRevision(value: unknown) {
  return `ctxr1.${sha256(value)}`;
}

function encodedContextValue(prefix: string, value: unknown) {
  return `${prefix}${Buffer.from(canonicalJson(value), 'utf8').toString('base64url')}`;
}

function decodedContextValue(value: unknown, prefix: string, label: string) {
  const encoded = String(value || '');
  if (!encoded.startsWith(prefix)) throw new Error(`${label}: invalid ${label} prefix.`);
  try {
    const decoded = JSON.parse(Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('not an object');
    return decoded;
  } catch (_) {
    throw new Error(`${label}: malformed opaque ${label}.`);
  }
}

function createContextHandle(source: ContextHandleSource) {
  const tool = String(source?.tool || '').trim();
  const project = String(source?.project || '').trim();
  const field = String(source?.field || '').trim();
  const revision = String(source?.revision || '').trim();
  const reason = String(source?.reason || '').trim();
  if (!tool || !project || !field || !revision || !reason) {
    throw new Error('context handle needs tool, project, field, revision, and omission reason.');
  }
  if (source.kind !== 'body' && source.kind !== 'rows') throw new Error('context handle kind must be body or rows.');
  if (typeof source.position !== 'string' && !Number.isSafeInteger(source.position)) {
    throw new Error('context handle needs a stable field or row position.');
  }
  return encodedContextValue(CONTEXT_HANDLE_PREFIX, {
    v: CONTEXT_HANDLE_VERSION,
    t: tool,
    p: project,
    k: source.kind,
    f: field,
    i: source.position,
    r: revision,
    o: reason,
    ...(source.selector ? { s: canonicalValue(source.selector) } : {}),
    ...(source.arguments ? { a: canonicalValue(source.arguments) } : {}),
  });
}

function decodeContextHandle(handle: unknown) {
  const value = decodedContextValue(handle, CONTEXT_HANDLE_PREFIX, 'context handle');
  if (value.v !== CONTEXT_HANDLE_VERSION || !value.t || !value.p || !value.k || !value.f || value.i == null || !value.r || !value.o) {
    throw new Error('context handle: unsupported or incomplete context handle.');
  }
  if (value.k !== 'body' && value.k !== 'rows') throw new Error('context handle: unknown page kind.');
  return {
    version: value.v,
    tool: String(value.t),
    project: String(value.p),
    kind: value.k as 'body' | 'rows',
    field: String(value.f),
    position: value.i as string | number,
    revision: String(value.r),
    reason: String(value.o),
    selector: value.s && typeof value.s === 'object' && !Array.isArray(value.s) ? value.s : {},
    arguments: value.a && typeof value.a === 'object' && !Array.isArray(value.a) ? value.a : {},
  };
}

function contextCursor(handle: string, position: number) {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('context cursor position must be a non-negative safe integer.');
  return encodedContextValue(CONTEXT_CURSOR_PREFIX, {
    v: CONTEXT_HANDLE_VERSION,
    h: sha256(String(handle)).slice(0, 24),
    p: position,
  });
}

function decodeContextCursor(handle: string, cursor: unknown) {
  const value = decodedContextValue(cursor, CONTEXT_CURSOR_PREFIX, 'context cursor');
  if (value.v !== CONTEXT_HANDLE_VERSION || value.h !== sha256(String(handle)).slice(0, 24)) {
    throw new Error('context cursor: cursor belongs to a different context handle.');
  }
  if (!Number.isSafeInteger(value.p) || value.p < 0) throw new Error('context cursor: invalid cursor position.');
  return value.p as number;
}

function contextRetrieval(source: ContextHandleSource, cursorPosition = 0): RetrievalInstruction & { reason: string } {
  const handle = createContextHandle(source);
  return {
    tool: 'context_page',
    arguments: {
      handle,
      cursor: contextCursor(handle, cursorPosition),
      expectedRevision: source.revision,
    },
    reason: source.reason,
  };
}

function contextPageByteLimit(value?: unknown) {
  if (value == null) return DEFAULT_CONTEXT_PAGE_BYTES;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < MIN_CONTEXT_PAGE_BYTES || limit > MAX_CONTEXT_PAGE_BYTES) {
    throw new Error(`context_page: limit must be an integer from ${MIN_CONTEXT_PAGE_BYTES} to ${MAX_CONTEXT_PAGE_BYTES} UTF-8 bytes.`);
  }
  return limit;
}

function utf8Slice(value: unknown, startBytes: number, maxBytes: number) {
  const source = String(value ?? '');
  const totalBytes = utf8ByteLength(source);
  if (!Number.isSafeInteger(startBytes) || startBytes < 0 || startBytes > totalBytes) {
    throw new Error(`context_page: cursor is past the ${totalBytes}-byte body.`);
  }
  let position = 0;
  let body = '';
  for (const character of source) {
    const characterBytes = utf8ByteLength(character);
    if (position < startBytes) {
      if (position + characterBytes > startBytes) throw new Error('context_page: cursor splits a UTF-8 character.');
      position += characterBytes;
      continue;
    }
    if (utf8ByteLength(body) + characterBytes > maxBytes) break;
    body += character;
    position += characterBytes;
  }
  return {
    body,
    cursorBytes: startBytes,
    pageBytes: utf8ByteLength(body),
    totalBytes,
    nextPosition: position < totalBytes ? position : null,
  };
}

function rowsWithinByteLimit(rows: unknown[], start: number, maxBytes: number) {
  if (!Number.isSafeInteger(start) || start < 0 || start > rows.length) {
    throw new Error(`context_page: cursor is past the ${rows.length}-row source.`);
  }
  const page: unknown[] = [];
  let position = start;
  while (position < rows.length) {
    const candidate = [...page, rows[position]];
    if (utf8ByteLength(JSON.stringify(candidate)) > maxBytes) break;
    page.push(rows[position]);
    position += 1;
  }
  if (!page.length && position < rows.length) {
    throw new RangeError(`context_page: one row exceeds the ${maxBytes}-byte page limit.`);
  }
  return {
    rows: page,
    cursorRow: start,
    pageBytes: utf8ByteLength(JSON.stringify(page)),
    totalRows: rows.length,
    nextPosition: position < rows.length ? position : null,
  };
}

function normalizedWatermarks(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, String(value[key])])) as Record<string, string>;
}

function normalizedItem(value: ProjectionItem, index: number) {
  const id = String(value?.id ?? '').trim();
  if (!id) throw new Error('context projection items need stable ids.');
  const body = String(value.body ?? value.text ?? value.content ?? '');
  const priority = Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0;
  const order = Number.isFinite(Number(value.order)) ? Number(value.order) : 0;
  return {
    id,
    kind: String(value.kind || 'context'),
    body,
    priority,
    order,
    watermark: value.watermark == null ? null : String(value.watermark),
    sourceIndex: index,
  };
}

function stableItems(items: ProjectionItem[]) {
  const ids = new Set<string>();
  const normalized = items.map(normalizedItem);
  for (const item of normalized) {
    if (ids.has(item.id)) throw new Error(`context projection item id "${item.id}" is duplicated.`);
    ids.add(item.id);
  }
  return normalized.sort((left, right) => (
    right.priority - left.priority
    || left.order - right.order
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    || left.sourceIndex - right.sourceIndex
  ));
}

function recipientProfile(value: any) {
  const supplied = typeof value === 'string' ? DEFAULT_RECIPIENT_PROFILES[value as keyof typeof DEFAULT_RECIPIENT_PROFILES] : value;
  if (!supplied || typeof supplied !== 'object') throw new Error('context projection needs a known recipient profile or explicit profile.');
  const id = String(supplied.id || supplied.recipient || '').trim();
  if (!id) throw new Error('context projection recipient profile needs an id.');
  return { id };
}

function includedItem(item: any, body: string) {
  return {
    id: item.id,
    kind: item.kind,
    body,
    bytes: utf8ByteLength(body),
    ...(item.watermark == null ? {} : { watermark: item.watermark }),
  };
}

function compileContextProjection(input: {
  recipient?: string | { id?: string; recipient?: string };
  profile?: string | { id?: string; recipient?: string };
  revision?: number;
  watermarks?: Record<string, string | number>;
  items?: ProjectionItem[];
}) {
  const profile = recipientProfile(input?.profile ?? input?.recipient);
  const revision = Number.isInteger(Number(input?.revision)) && Number(input?.revision) >= 0 ? Number(input?.revision) : 0;
  const watermarks = normalizedWatermarks(input?.watermarks);
  const candidates = stableItems(Array.isArray(input?.items) ? input.items : []);
  return {
    version: CONTEXT_PROJECTION_VERSION,
    recipient: profile.id,
    revision,
    watermarks,
    items: candidates.map((item) => includedItem(item, item.body)),
  };
}

module.exports = {
  CONTEXT_PROJECTION_VERSION,
  CONTEXT_HANDLE_VERSION,
  DEFAULT_CONTEXT_PAGE_BYTES,
  MAX_CONTEXT_PAGE_BYTES,
  MIN_CONTEXT_PAGE_BYTES,
  DEFAULT_RECIPIENT_PROFILES,
  RECIPIENT_PROFILES,
  compileContextProjection,
  contextRevision,
  createContextHandle,
  decodeContextHandle,
  contextCursor,
  decodeContextCursor,
  contextRetrieval,
  contextPageByteLimit,
  utf8Slice,
  rowsWithinByteLimit,
  utf8ByteLength,
  utf8Excerpt,
};
