import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class UsageError extends Error {}

export function repoRootFrom(moduleUrl) {
  return path.resolve(fileURLToPath(new URL('.', moduleUrl)), '..', '..');
}

export function isMain(moduleUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === moduleUrl;
}

export function splitList(value) {
  if (value === undefined || value === null || value === '') return null;
  const parts = String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function runCli(moduleUrl, main) {
  if (!isMain(moduleUrl)) return;
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    process.exitCode = error instanceof UsageError ? 2 : 1;
    console.error(`${path.basename(fileURLToPath(moduleUrl))}: ${error.message}`);
  }
}
