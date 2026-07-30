import { readFileSync } from 'node:fs';

import { runCli, UsageError } from './lib/cli.mjs';
import { parseVersion } from './lib/semver.mjs';

export function readMarketplaceVersion(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  parseVersion(manifest.version, 'marketplace version');
  return manifest.version;
}

export function chooseDailyRelease({ version, releaseExists }) {
  parseVersion(version, 'marketplace version');
  const tag = `v${version}`;
  return {
    decision: releaseExists ? 'no-op' : 'publish',
    tag,
    version,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new UsageError(`unknown argument ${argument}`);
    const [name, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (!name || value === undefined) throw new UsageError(`${argument} needs a value`);
    values[name] = value;
  }
  if (!values.marketplace) throw new UsageError('--marketplace is required');
  if (!['true', 'false'].includes(values['release-exists'])) {
    throw new UsageError('--release-exists must be true or false');
  }
  return values;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const result = chooseDailyRelease({
    version: readMarketplaceVersion(options.marketplace),
    releaseExists: options['release-exists'] === 'true',
  });
  console.log(JSON.stringify(result));
}

runCli(import.meta.url, main);
