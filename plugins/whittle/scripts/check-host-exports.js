'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const generator = path.join(root, 'scripts', 'generate-host-exports.js');
const expected = path.join(root, 'exports');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whittle-host-exports-'));

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  }).sort();
}

try {
  childProcess.execFileSync(process.execPath, [generator, '--out', temporary], { stdio: 'pipe' });
  assert.deepEqual(files(temporary), files(expected), 'generated export file set drifted');
  for (const relative of files(expected)) {
    assert.equal(fs.readFileSync(path.join(temporary, relative), 'utf8'), fs.readFileSync(path.join(expected, relative), 'utf8'), relative + ' drifted');
  }
  process.stdout.write('Whittle host exports match the canonical generator.\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
