import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import owner from '../lib/policy.cjs';
import { readConfig } from '../lib/crap-inputs.mjs';

const { DEFAULT_POLICY, qualityPolicy, readQualityPolicy, debtTicketInstruction } = owner;

function policyProject(context) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-policy-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, '.claude/quality-gate'), { recursive: true });
  return project;
}

test('policy is project opt-in with shipped defaults and no home-rule dependency', (context) => {
  const project = policyProject(context);
  assert.equal(readQualityPolicy(project), undefined);
  fs.writeFileSync(path.join(project, '.claude/quality-gate/crap.json'), '{}');
  assert.deepEqual(readQualityPolicy(project), {
    threshold: 6, legacyRatchet: 'not-worse', unverifiedHandling: 'debt',
    debtTicketMode: 'standing-per-boundary', installMode: 'local',
  });
  assert.deepEqual(qualityPolicy(), DEFAULT_POLICY);
});

test('policy preserves supported overrides and refuses unsupported policy values', () => {
  assert.equal(qualityPolicy({ policy: { debtTicketMode: 'per-delivery' } }).debtTicketMode, 'per-delivery');
  assert.equal(qualityPolicy({ policy: { debtTicketMode: 'none' } }).debtTicketMode, 'none');
  assert.equal(qualityPolicy({ policy: { unverifiedHandling: 'block' } }).unverifiedHandling, 'block');
  assert.throws(() => qualityPolicy({ policy: { threshold: 9 } }), /policy.threshold/);
  assert.throws(() => qualityPolicy({ policy: { legacyRatchet: 'ignore' } }), /policy.legacyRatchet/);
  assert.throws(() => qualityPolicy({ policy: { debtTicketMode: 'unknown' } }), /policy.debtTicketMode/);
  assert.throws(() => qualityPolicy({ policy: { installMode: 'tracked' } }), /policy.installMode/);
  assert.throws(() => qualityPolicy({ policy: { unknown: true } }), /Unknown quality policy field/);
  assert.throws(() => qualityPolicy({ policy: [] }), /JSON object/);
});

test('normal config loading validates the same owned policy', (context) => {
  const project = policyProject(context);
  const configuration = path.join(project, '.claude/quality-gate/crap.json');
  fs.writeFileSync(configuration, '{"policy":{"debtTicketMode":"broken"}}');
  assert.throws(() => readConfig(project), /policy.debtTicketMode/);
  fs.writeFileSync(configuration, '[]');
  assert.throws(() => readQualityPolicy(project), /JSON object/);
  fs.writeFileSync(configuration, '{broken');
  assert.throws(() => readQualityPolicy(project), /JSON/);
});

test('debt instructions distinguish standing boundaries deliveries and no tickets', () => {
  assert.match(debtTicketInstruction(DEFAULT_POLICY), /Reuse one standing.*per unsupported capture boundary/);
  assert.match(debtTicketInstruction({ debtTicketMode: 'per-delivery' }), /one measurement-debt ticket for this delivery/);
  assert.match(debtTicketInstruction({ debtTicketMode: 'none' }), /without creating a debt ticket/);
});


test('effective policy records shipped defaults without writing a project file', (context) => {
  const project = policyProject(context);
  assert.deepEqual(owner.qualityPolicyOrDefault(project), { ...DEFAULT_POLICY, source: 'default' });
  assert.equal(fs.existsSync(path.join(project, '.claude/quality-gate/crap.json')), false);
});

test('explicit project policy overrides shipped defaults and records its source', (context) => {
  const project = policyProject(context);
  fs.writeFileSync(path.join(project, '.claude/quality-gate/crap.json'), JSON.stringify({ policy: { unverifiedHandling: 'block', debtTicketMode: 'none' } }));
  assert.deepEqual(owner.qualityPolicyOrDefault(project), { ...DEFAULT_POLICY, unverifiedHandling: 'block', debtTicketMode: 'none', source: 'project' });
});
