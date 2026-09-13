'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { downloadVerifiedArchive } = require('../lib/release-verification.js');

const name = 'claude-code-proxy-windows-amd64.zip';
const archive = Buffer.from('fixture archive');
const digest = crypto.createHash('sha256').update(archive).digest('hex');

function fixture({ checksum = `${digest}  ${name}\n`, missing = false, checksumStatus = 200, archiveStatus = 200 } = {}) {
  const requests = [];
  const logs = [];
  const release = { tag_name: 'v-test', assets: [{ name, browser_download_url: 'https://fixture.invalid/archive' }] };
  if (!missing) release.assets.push({ name: name.replace('.zip', '.sha256'), browser_download_url: 'https://fixture.invalid/checksum' });
  return {
    requests, logs,
    run: () => downloadVerifiedArchive(release, name, {
      log: (line) => logs.push(line),
      fetchUrl: async (url) => {
        requests.push(url);
        return url.endsWith('/checksum')
          ? { status: checksumStatus, body: Buffer.from(checksum) }
          : { status: archiveStatus, body: archive };
      },
    }),
  };
}

test('missing checksum asset fails before downloading the archive', async () => {
  const f = fixture({ missing: true });
  await assert.rejects(f.run(), /missing required checksum/);
  assert.deepEqual(f.requests, []);
});

for (const checksum of ['', 'checksum unavailable', `${digest}  another.zip`, `${digest}\n${digest}`, `prefix ${digest}`]) {
  test(`invalid checksum is rejected: ${JSON.stringify(checksum)}`, async () => {
    const f = fixture({ checksum });
    await assert.rejects(f.run(), /invalid checksum/);
    assert.equal(f.requests.length, 1);
    assert(!f.logs.includes('sha256 verified'));
  });
}

test('checksum HTTP errors fail closed', async () => {
  const f = fixture({ checksumStatus: 404 });
  await assert.rejects(f.run(), /checksum download failed with 404/);
  assert.equal(f.requests.length, 1);
});

test('incorrect archive digest and archive HTTP errors are rejected', async () => {
  const wrong = fixture({ checksum: 'a'.repeat(64) });
  await assert.rejects(wrong.run(), /sha256 mismatch/);
  assert(!wrong.logs.includes('sha256 verified'));
  await assert.rejects(fixture({ archiveStatus: 503 }).run(), /download failed with 503/);
});

for (const checksum of [digest, `${digest.toUpperCase()} *${name}\r\n`, `${digest}  ${name}\n`]) {
  test(`matching checksum returns verified bytes: ${JSON.stringify(checksum)}`, async () => {
    const f = fixture({ checksum });
    assert.deepEqual(await f.run(), archive);
    assert.equal(f.logs.filter((line) => line === 'sha256 verified').length, 1);
  });
}
