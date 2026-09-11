'use strict';

const crypto = require('node:crypto');

async function downloadVerifiedArchive(release, assetName, { fetchUrl, log = () => {} }) {
  const assets = release.assets || [];
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) throw new Error(`no asset ${assetName} in release ${release.tag_name}`);
  const checksumName = assetName.replace(/\.(zip|tar\.gz)$/, '.sha256');
  const checksumAsset = assets.find((entry) => entry.name === checksumName);
  if (!checksumAsset) throw new Error(`missing required checksum asset ${checksumName}; refusing to install`);

  const checksumResponse = await fetchUrl(checksumAsset.browser_download_url);
  if (checksumResponse.status !== 200) throw new Error(`checksum download failed with ${checksumResponse.status}`);
  const match = /^([a-f0-9]{64})(?:[ \t]+\*?([^\r\n]+))?$/i.exec(checksumResponse.body.toString().trim());
  if (!match || (match[2] && match[2].trim() !== assetName)) {
    throw new Error(`invalid checksum for ${assetName}; refusing to install`);
  }

  log(`downloading ${assetName} (${release.tag_name})...`);
  const archive = await fetchUrl(asset.browser_download_url, { timeout: 120000 });
  if (archive.status !== 200) throw new Error(`download failed with ${archive.status}`);
  const expected = match[1].toLowerCase();
  const actual = crypto.createHash('sha256').update(archive.body).digest('hex');
  if (expected !== actual) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  log('sha256 verified');
  return archive.body;
}

module.exports = { downloadVerifiedArchive };
