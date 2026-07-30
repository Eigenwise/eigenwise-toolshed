import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chooseDailyRelease, readMarketplaceVersion } from '../daily-release.mjs';
import { makeRepo } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'daily-release.mjs');

test('a marketplace version with an existing release is a no-op', () => {
  assert.deepEqual(
    chooseDailyRelease({ version: '3.286.0', releaseExists: true }),
    { decision: 'no-op', tag: 'v3.286.0', version: '3.286.0' },
  );
});

test('a new marketplace version publishes its matching tag', () => {
  assert.deepEqual(
    chooseDailyRelease({ version: '3.286.1', releaseExists: false }),
    { decision: 'publish', tag: 'v3.286.1', version: '3.286.1' },
  );
});

test('a repeat run after publication remains a no-op', () => {
  const firstRun = chooseDailyRelease({ version: '3.286.1', releaseExists: false });
  const repeatRun = chooseDailyRelease({ version: firstRun.version, releaseExists: true });

  assert.equal(firstRun.decision, 'publish');
  assert.equal(repeatRun.decision, 'no-op');
  assert.equal(repeatRun.tag, firstRun.tag);
});

test('the version comes from the marketplace manifest', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const marketplace = path.join(repo.root, '.claude-plugin', 'marketplace.json');
  writeFileSync(marketplace, JSON.stringify({ version: '3.286.2' }));

  assert.equal(readMarketplaceVersion(marketplace), '3.286.2');
});

test('the CLI works from outside the release directory', (t) => {
  const repo = makeRepo({ marketplaceVersion: '3.286.3' });
  t.after(repo.cleanup);
  const marketplace = path.join(repo.root, '.claude-plugin', 'marketplace.json');
  const output = execFileSync(process.execPath, [script, '--marketplace', marketplace, '--release-exists', 'true'], {
    cwd: repo.root,
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), {
    decision: 'no-op',
    tag: 'v3.286.3',
    version: '3.286.3',
  });
});
