import path from 'node:path';
import { NpmRuntimeInstaller, PinnedNpmRuntimeAcquirer, type PinnedNpmRuntimeOptions } from '../../runtime.js';
import type { SemanticEngineRuntime } from '../../runtime-contract.js';

export const pyrightEngineId = 'pyright';
export const pyrightEngineVersion = '1.1.411';

export interface PyrightRuntimeOptions extends Omit<PinnedNpmRuntimeOptions, 'cacheIdentity' | 'engineVersion' | 'runtimeManifestDirectory'> {
  runtimeManifestDirectory?: string;
}

export class PyrightRuntimeAcquirer {
  private readonly runtime: PinnedNpmRuntimeAcquirer;

  constructor(options: PyrightRuntimeOptions = {}) {
    this.runtime = new PinnedNpmRuntimeAcquirer({
      ...options,
      cacheIdentity: 'any',
      engineVersion: pyrightEngineVersion,
      installer: options.installer ?? new NpmRuntimeInstaller(),
      runtimeManifestDirectory: options.runtimeManifestDirectory ?? path.resolve(__dirname, '..', '..', '..', 'runtime-pyright'),
    });
  }

  acquire(): Promise<SemanticEngineRuntime> {
    return this.runtime.acquire();
  }
}
