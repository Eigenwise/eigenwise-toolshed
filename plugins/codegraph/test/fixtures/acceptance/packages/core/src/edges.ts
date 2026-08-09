// @ts-nocheck
import { readFile } from 'node:fs';
import { absent } from './absent';

export function edgeCases(value: Record<string, () => string>): string {
  const methodName = 'run';
  const dynamicResult = value[methodName]();
  return readFile ? `${dynamicResult}:${absent}` : dynamicResult;
}
