import { createHash } from 'node:crypto';

export const maximumCursorBytes = 16 * 1_024;

export interface QueryCursor {
  version: 1;
  snapshotId: string;
  queryHash: string;
  offset: number;
}

export function normalizedQueryHash(query: unknown): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex');
}

export function encodeCursor(snapshotId: string, query: unknown, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('cursor offset must be a non-negative integer');
  const cursor: QueryCursor = { version: 1, snapshotId, queryHash: normalizedQueryHash(query), offset };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(cursor: string, snapshotId: string, query: unknown): number {
  if (Buffer.byteLength(cursor, 'utf8') > maximumCursorBytes) throw new Error('graph cursor exceeds the input budget');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('invalid graph cursor'); }
  if (typeof value !== 'object' || value === null) throw new Error('invalid graph cursor');
  const candidate = value as Partial<QueryCursor>;
  const offset = candidate.offset;
  if (candidate.version !== 1 || candidate.snapshotId !== snapshotId || candidate.queryHash !== normalizedQueryHash(query) || !Number.isSafeInteger(offset) || offset === undefined || offset < 0) {
    throw new Error('graph cursor does not match this snapshot and query');
  }
  return offset;
}
