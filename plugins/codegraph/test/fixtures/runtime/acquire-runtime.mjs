import { appendFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptRuntimeAcquirer } from '../../../lib/runtime.js';

const [stateDirectory, runtimeManifestDirectory, installRecordFile, delayMilliseconds] = process.argv.slice(2);

if (stateDirectory === undefined || runtimeManifestDirectory === undefined || installRecordFile === undefined || delayMilliseconds === undefined) {
  throw new Error('runtime fixture acquirer requires state, manifest, record, and delay arguments');
}

class FixtureRuntimeInstaller {
  async install(stageDirectory) {
    await appendFile(installRecordFile, 'installed\n');
    process.stdout.write('installer-started\n');
    await new Promise((resolve) => setTimeout(resolve, Number(delayMilliseconds)));
    await cp(path.join(fileURLToPath(new URL('.', import.meta.url)), 'node_modules'), path.join(stageDirectory, 'node_modules'), { recursive: true });
  }
}

await new TypeScriptRuntimeAcquirer({
  architecture: 'x64',
  installer: new FixtureRuntimeInstaller(),
  platform: 'win32',
  runtimeManifestDirectory,
  stateDirectory,
}).acquire();
