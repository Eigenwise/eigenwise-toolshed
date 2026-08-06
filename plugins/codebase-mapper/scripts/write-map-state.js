'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mapDocuments = require('../hooks/lib/map-documents');
const plugin = require('../.claude-plugin/plugin.json');

function projectDirectory(args) {
  const index = args.indexOf('--project');
  if (index === -1) return process.cwd();
  if (!args[index + 1]) throw new Error('--project needs a directory path.');
  return path.resolve(args[index + 1]);
}

function documentNames(directory, relative = '') {
  const documents = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) documents.push(...documentNames(directory, next));
    else if (entry.isFile() && mapDocuments.safeDocumentPath(next)) documents.push(next);
  }
  return documents;
}

function gitCommit(projectDir) {
  const result = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeMapState(projectDir) {
  const directory = mapDocuments.mapDirectory(projectDir);
  const indexPath = path.join(directory, mapDocuments.INDEX_NAME);
  if (!fs.existsSync(indexPath)) throw new Error('Missing .claude/.codebase-info/INDEX.md.');

  const documents = documentNames(directory).filter((name) => name !== mapDocuments.INDEX_NAME).sort();
  const hashedDocuments = [mapDocuments.INDEX_NAME, ...documents];
  const hashes = Object.fromEntries(hashedDocuments.map((name) => [
    name,
    mapDocuments.hashContent(fs.readFileSync(path.join(directory, name), 'utf8')),
  ]));
  const state = {
    schemaVersion: 1,
    tool: 'codebase-mapper',
    version: plugin.version,
    mappedAt: new Date().toISOString().slice(0, 10),
    gitCommit: gitCommit(projectDir),
    documents,
    hashes,
  };
  const statePath = path.join(directory, mapDocuments.STATE_NAME);
  const temporaryPath = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temporaryPath, statePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return state;
}

try {
  const state = writeMapState(projectDirectory(process.argv.slice(2)));
  process.stdout.write(`Wrote map state for ${state.documents.length} document(s).\n`);
} catch (error) {
  process.stderr.write(`codebase-mapper state write failed: ${error.message}\n`);
  process.exitCode = 1;
}

module.exports = { documentNames, gitCommit, projectDirectory, writeMapState };
