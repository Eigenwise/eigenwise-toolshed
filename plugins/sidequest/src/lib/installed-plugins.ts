import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const registryLockTimeoutMilliseconds = 10_000;
const registryLockRetryMilliseconds = 10;

function temporaryRegistryPath(registryPath: string): string {
  return path.join(path.dirname(registryPath), `.${path.basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function waitForRegistryLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, registryLockRetryMilliseconds);
}

function acquireRegistryLock(registryPath: string): { descriptor: number; path: string } {
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + registryLockTimeoutMilliseconds;
  for (;;) {
    try {
      return { descriptor: fs.openSync(lockPath, 'wx'), path: lockPath };
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST' || Date.now() >= deadline) throw error;
      waitForRegistryLock();
    }
  }
}

function replaceRegistryFile(temporaryPath: string, registryPath: string): void {
  const deadline = Date.now() + registryLockTimeoutMilliseconds;
  for (;;) {
    try {
      fs.renameSync(temporaryPath, registryPath);
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== 'EPERM' || Date.now() >= deadline) throw error;
      waitForRegistryLock();
    }
  }
}

export function writeInstalledPluginsAtomically(registryPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const lock = acquireRegistryLock(registryPath);
  const temporaryPath = temporaryRegistryPath(registryPath);
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf8');
    replaceRegistryFile(temporaryPath, registryPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.closeSync(lock.descriptor);
    fs.rmSync(lock.path, { force: true });
  }
}
