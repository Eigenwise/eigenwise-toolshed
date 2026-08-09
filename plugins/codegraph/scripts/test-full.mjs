import { cp } from 'node:fs/promises';
import path from 'node:path';
import { TypeScriptRuntimeAcquirer } from '../lib/runtime.js';

const [manifestDirectory, sourceDirectory, stateDirectory] = process.argv.slice(2);
if (manifestDirectory === undefined || sourceDirectory === undefined || stateDirectory === undefined) throw new Error('test-full requires manifest, source, and state directories');

class LocalPackageSource {
  async install(stageDirectory) {
    await cp(path.join(sourceDirectory, 'node_modules'), path.join(stageDirectory, 'node_modules'), { recursive: true });
  }
}

const runtime = await new TypeScriptRuntimeAcquirer({
  architecture: process.arch,
  installer: new LocalPackageSource(),
  platform: process.platform,
  runtimeManifestDirectory: manifestDirectory,
  stateDirectory,
}).acquire();
process.stdout.write(`${JSON.stringify({ engineId: runtime.engineId, engineVersion: runtime.engineVersion })}\n`);
