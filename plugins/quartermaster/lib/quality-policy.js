'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { installedQualityGateBin } = require('./quality-gate.js');

function qualityPolicyOwner(env) {
  const bin = installedQualityGateBin(env);
  if (!bin) throw new Error('Install Quality Gate before proposing or writing its project policy');
  return require(path.join(path.dirname(bin), '..', 'lib', 'policy.cjs'));
}

function qualityPolicyProposal(project, env = process.env) {
  const owner = qualityPolicyOwner(env);
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  const current = fs.existsSync(configuration) ? JSON.parse(fs.readFileSync(configuration, 'utf8')) : {};
  return { ...current, policy: owner.qualityPolicy(current) };
}

function writeApprovedQualityPolicy(project, approved, env = process.env) {
  if (approved !== true) throw new Error('Project quality policy requires explicit approval');
  const proposal = qualityPolicyProposal(project, env);
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  fs.mkdirSync(path.dirname(configuration), { recursive: true });
  fs.writeFileSync(configuration, JSON.stringify(proposal, null, 2) + '\n');
  return configuration;
}

function executorPolicyReferences(project) {
  const agents = path.join(project, '.claude/agents');
  if (!fs.existsSync(agents)) return [];
  return fs.readdirSync(agents).filter((name) => name.endsWith('.md'))
    .map((name) => path.join(agents, name))
    .filter((file) => /Configured quality (?:gate|policy):|CRAP (?:below|<)\s*6/.test(fs.readFileSync(file, 'utf8')));
}

function qualityPolicyFinding(project, env = process.env) {
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  if (fs.existsSync(configuration)) {
    const policy = qualityPolicyOwner(env).readQualityPolicy(project);
    return 'Project quality policy configured: ' + JSON.stringify(policy);
  }
  const references = executorPolicyReferences(project);
  if (references.length) return 'Project executors reference a quality policy that is not configured: ' + references.join(', ') + '. Propose /quartermaster:setup for this project; do not write a policy without approval.';
  return 'No quality policy configured; no project executor policy references found.';
}

module.exports = { qualityPolicyProposal, writeApprovedQualityPolicy, qualityPolicyFinding };
