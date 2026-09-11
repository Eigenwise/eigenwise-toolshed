'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANONICAL_PROJECT_ID = /^[a-f0-9]{64}$/;

function defaultDataDir(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench');
}

function defaultConfigPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, 'observability.json');
}

function consentedProjectIds(configFile) {
  try {
    const projects = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.observability?.optedInProjects;
    return new Set(Array.isArray(projects)
      ? projects.map((project) => project?.project_id).filter((projectId) => typeof projectId === 'string' && CANONICAL_PROJECT_ID.test(projectId))
      : []);
  } catch {
    return new Set();
  }
}

function createConsentGate({ configFile }) {
  let fingerprint;
  let projects = new Set();
  return (projectId) => {
    let stat;
    try { stat = fs.statSync(configFile, { throwIfNoEntry: false }); } catch {}
    const nextFingerprint = stat ? `${stat.mtimeMs}:${stat.size}` : null;
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      projects = consentedProjectIds(configFile);
    }
    return typeof projectId === 'string' && projects.has(projectId);
  };
}

module.exports = { CANONICAL_PROJECT_ID, consentedProjectIds, createConsentGate, defaultConfigPath, defaultDataDir };
