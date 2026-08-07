'use strict';

const fs = require('node:fs');
const path = require('node:path');

function realpath(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

function resolvedPath(value) {
  const resolved = path.resolve(String(value || '.'));
  const missingSegments = [];
  let existingPath = resolved;

  for (;;) {
    try {
      return path.join(realpath(existingPath), ...missingSegments);
    } catch {
      const parent = path.dirname(existingPath);
      if (parent === existingPath) return resolved;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

function canonicalPath(value, platform = process.platform) {
  const resolved = resolvedPath(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = { canonicalPath, resolvedPath };
