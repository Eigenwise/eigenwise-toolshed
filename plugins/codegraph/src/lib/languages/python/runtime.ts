import path from 'node:path';
import { pluginRootDirectory } from '../../paths.js';
import { NpmRuntimeInstaller, PinnedNpmRuntimeAcquirer, type PinnedNpmRuntimeOptions } from '../../runtime.js';
import type { SemanticEngineRuntime } from '../../runtime-contract.js';

export const pyrightEngineId = 'pyright';
export const pyrightEngineVersion = '1.1.411';

export interface PyrightRuntimeOptions extends Omit<PinnedNpmRuntimeOptions, 'cacheIdentity' | 'engineVersion' | 'runtimeManifestDirectory'> {
  runtimeManifestDirectory?: string;
}

export class PyrightRuntimeAcquirer {
  private readonly runtime: PinnedNpmRuntimeAcquirer;
  readonly manifestDirectory: string;

  constructor(options: PyrightRuntimeOptions = {}) {
    this.manifestDirectory = options.runtimeManifestDirectory ?? path.join(pluginRootDirectory(__dirname), 'runtime-pyright');
    this.runtime = new PinnedNpmRuntimeAcquirer({
      ...options,
      cacheIdentity: 'any',
      engineVersion: pyrightEngineVersion,
      installer: options.installer ?? new NpmRuntimeInstaller(),
      runtimeManifestDirectory: this.manifestDirectory,
    });
  }

  acquire(): Promise<SemanticEngineRuntime> {
    return this.runtime.acquire();
  }
}
