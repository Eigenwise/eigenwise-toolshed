import type { GraphResultOrder } from './model.ts';

export const minimumTokenBudget = 500;
export const maximumTokenBudget = 16_000;
export const defaultTokenBudget = 4_000;
export const maximumResponseBytes = 64 * 1024;

export interface QueryLimits { maxDepth?: number; tokenBudget?: number; maxResults?: number }
export interface AppliedLimits { maxDepth: number; tokenBudget: number; maxResults: number }

export function applyQueryLimits(limits: QueryLimits = {}): AppliedLimits {
  const maxDepth = limits.maxDepth ?? 3;
  const tokenBudget = limits.tokenBudget ?? defaultTokenBudget;
  const maxResults = limits.maxResults ?? 200;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) throw new Error('maxDepth must be an integer from 1 through 8');
  if (!Number.isInteger(tokenBudget) || tokenBudget < minimumTokenBudget || tokenBudget > maximumTokenBudget) throw new Error('tokenBudget must be an integer from 500 through 16000');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1_000) throw new Error('maxResults must be an integer from 1 through 1000');
  return { maxDepth, tokenBudget, maxResults };
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 0))].sort();
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

export interface BoundedResults<Result extends GraphResultOrder> {
  results: Result[];
  omitted: number;
  tokenEstimate: number;
}

export function boundResults<Result extends GraphResultOrder>(orderedResults: readonly Result[], tokenBudget: number, maxResults: number): BoundedResults<Result> {
  const results: Result[] = [];
  let bytes = 0;
  for (const result of orderedResults) {
    if (results.length >= maxResults) break;
    const nextBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (results.length > 0 && (Math.ceil((bytes + nextBytes) / 4) > tokenBudget || bytes + nextBytes > maximumResponseBytes)) break;
    results.push(result);
    bytes += nextBytes;
  }
  return { results, omitted: orderedResults.length - results.length, tokenEstimate: Math.ceil(bytes / 4) };
}
