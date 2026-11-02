'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { qualityPolicyProposal, writeApprovedQualityPolicy, qualityPolicyFinding } = require('../lib/quality-policy.js');

function policyFixture(context) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-policy-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const home = path.join(project, 'home');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'quality-gate@eigenwise-toolshed': [{ installPath: path.resolve(__dirname, '../../quality-gate') }],
  } }));
  return { project, env: { ...process.env, CLAUDE_CONFIG_DIR: home } };
}

test('approved project policy preserves coverage setup and writes owned defaults only after approval', (context) => {
  const { project, env } = policyFixture(context);
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  assert.equal(fs.existsSync(configuration), false);
  assert.equal(qualityPolicyProposal(project, env).policy.debtTicketMode, 'standing-per-boundary');
  assert.equal(fs.existsSync(configuration), false);
  assert.throws(() => writeApprovedQualityPolicy(project, false, env), /explicit approval/);
  writeApprovedQualityPolicy(project, true, env);
  const contents = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  contents.coverageCommand = 'npm run coverage';
  contents.policy.debtTicketMode = 'none';
  fs.writeFileSync(configuration, JSON.stringify(contents));
  writeApprovedQualityPolicy(project, true, env);
  const written = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  assert.equal(written.coverageCommand, 'npm run coverage');
  assert.equal(written.policy.debtTicketMode, 'none');
  assert.equal(written.policy.threshold, 6);
  assert.match(qualityPolicyFinding(project, env), /Project quality policy configured:/);
});

test('doctor reports an executor policy reference without project configuration', (context) => {
  const { project, env } = policyFixture(context);
  assert.match(qualityPolicyFinding(project, env), /No quality policy configured/);
  fs.mkdirSync(path.join(project, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/agents/executor.md'), 'Configured quality policy: threshold from Quality Gate');
  assert.match(qualityPolicyFinding(project, env), /executors reference a quality policy that is not configured/);
  assert.equal(fs.existsSync(path.join(project, '.claude/quality-gate/crap.json')), false);
});

test('invalid existing policy is preserved instead of overwritten', (context) => {
  const { project, env } = policyFixture(context);
  fs.mkdirSync(path.join(project, '.claude/quality-gate'), { recursive: true });
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  fs.writeFileSync(configuration, '[]');
  assert.throws(() => writeApprovedQualityPolicy(project, true, env), /JSON object/);
  assert.equal(fs.readFileSync(configuration, 'utf8'), '[]');
});
