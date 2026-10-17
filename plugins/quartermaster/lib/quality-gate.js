'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { pluginsDir } = require('./paths.js');

const QUALITY_GATE_INSTALL = '/plugin install quality-gate@eigenwise-toolshed';
const RETIRED_NOTICE = `quartermaster crap is retired: CRAP scoring lives in quality-gate. Install it with ${QUALITY_GATE_INSTALL}\n`;

function installRecords(env) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(pluginsDir(env), 'installed_plugins.json'), 'utf8'));
    return Object.entries(registry.plugins ?? {}).filter(([id]) => id.startsWith('quality-gate@')).flatMap(([, records]) => records);
  } catch {
    return [];
  }
}

function installedQualityGateBin(env = process.env) {
  const bins = installRecords(env).filter((record) => record?.installPath).map((record) => path.join(record.installPath, 'bin', 'quality-gate.js'));
  return bins.find((bin) => fs.existsSync(bin)) ?? null;
}

/** Runs `quality-gate crap` with the caller's arguments; without an install, exits 2 so no gate reads it as a pass. */
function delegateCrap(argv, env = process.env) {
  const bin = installedQualityGateBin(env);
  if (!bin) {
    process.stderr.write(RETIRED_NOTICE);
    return 2;
  }
  return spawnSync(process.execPath, [bin, 'crap', ...argv], { stdio: 'inherit', env, windowsHide: true }).status ?? 2;
}

module.exports = { QUALITY_GATE_INSTALL, delegateCrap, installedQualityGateBin };
