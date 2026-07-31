'use strict';

const fs = require('fs');
const path = require('path');

function createAssets(dependencies: any) {
  const { assetsDir, ensureDir } = dependencies;

  function sanitizeFilename(name?: any) {
    const base = path.basename(String(name || 'image')).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
    return base || 'image';
  }

  function copyAsset(slug?: any, id?: any, srcPath?: any) {
    const src = path.resolve(srcPath);
    const data = fs.readFileSync(src);
    const dir = assetsDir(slug, id);
    ensureDir(dir);
    let fname = sanitizeFilename(path.basename(src));
    if (!path.extname(fname)) fname += '.png';
    let dest = path.join(dir, fname);
    let n = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(fname);
      const stem = fname.slice(0, -ext.length || undefined);
      dest = path.join(dir, `${stem}-${n}${ext}`);
      n++;
    }
    fs.writeFileSync(dest, data);
    return path.basename(dest);
  }

  function assetPath(slug?: any, id?: any, filename?: any) {
    const safe = path.basename(String(filename));
    return path.join(assetsDir(slug, id), safe);
  }

  function saveAssetData(slug?: any, id?: any, name?: any, buffer?: any) {
    const dir = assetsDir(slug, id);
    ensureDir(dir);
    let fname = sanitizeFilename(name || 'pasted.png');
    if (!path.extname(fname)) fname += '.png';
    let dest = path.join(dir, fname);
    let n = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(fname);
      const stem = fname.slice(0, -ext.length || undefined);
      dest = path.join(dir, `${stem}-${n}${ext}`);
      n++;
    }
    fs.writeFileSync(dest, buffer);
    return path.basename(dest);
  }

  return { copyAsset, assetPath, saveAssetData };
}

module.exports = { createAssets };
