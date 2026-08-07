'use strict';

const fs = require('fs');
const path = require('path');

function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  const missingSegments = [];
  let existingAncestor = resolved;

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  try {
    const canonical = fs.realpathSync.native(existingAncestor);
    const completed = path.join(canonical, ...missingSegments);
    return process.platform === 'win32' ? completed.toLowerCase() : completed;
  } catch (_) {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function projectRelative(projectDir, runtimePath) {
  return path.relative(canonicalPath(projectDir), canonicalPath(runtimePath)).replace(/\\/g, '/');
}

module.exports = { canonicalPath, projectRelative };
