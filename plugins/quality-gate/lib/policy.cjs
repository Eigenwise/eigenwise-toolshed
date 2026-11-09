'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY = Object.freeze({
  threshold: 6,
  legacyRatchet: 'not-worse',
  unverifiedHandling: 'debt',
  debtTicketMode: 'standing-per-boundary',
  installMode: 'local',
});

const POLICY_CHOICES = {
  threshold: [6],
  legacyRatchet: ['not-worse'],
  unverifiedHandling: ['debt', 'block'],
  debtTicketMode: ['standing-per-boundary', 'per-delivery', 'none'],
  installMode: ['local'],
};

function qualityPolicy(configuration = {}) {
  if (Object.prototype.toString.call(configuration) !== '[object Object]') throw new Error('Quality Gate config must be a JSON object');
  const supplied = configuration.policy === undefined ? {} : configuration.policy;
  if (Object.prototype.toString.call(supplied) !== '[object Object]') throw new Error('policy must be a JSON object');
  for (const [name, value] of Object.entries(supplied)) validatePolicyChoice(name, value);
  return { ...DEFAULT_POLICY, ...supplied };
}

function validatePolicyChoice(name, value) {
  if (!Object.hasOwn(POLICY_CHOICES, name)) throw new Error('Unknown quality policy field: ' + name);
  if (!POLICY_CHOICES[name].includes(value)) throw new Error('policy.' + name + ' must be one of: ' + POLICY_CHOICES[name].join(', '));
}

function readQualityPolicy(project) {
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  if (!fs.existsSync(configuration)) return undefined;
  const contents = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  if (Object.prototype.toString.call(contents) !== '[object Object]') throw new Error('Quality Gate config must be a JSON object');
  return qualityPolicy(contents);
}

function qualityPolicyOrDefault(project) {
  const configured = readQualityPolicy(project);
  return { ...(configured ?? DEFAULT_POLICY), source: configured ? 'project' : 'default' };
}

function debtTicketInstruction(policy) {
  const instructions = {
    'standing-per-boundary': 'Reuse one standing measurement-debt ticket per unsupported capture boundary; append affected deliveries to that ticket. Create it only when none exists.',
    'per-delivery': 'File one measurement-debt ticket for this delivery.',
    none: 'Report measurement debt in the delivery evidence without creating a debt ticket.',
  };
  return instructions[policy.debtTicketMode];
}

module.exports = { DEFAULT_POLICY, qualityPolicy, readQualityPolicy, qualityPolicyOrDefault, debtTicketInstruction };
