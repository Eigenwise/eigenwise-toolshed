import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-home-'));

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');
const verification = require('../lib/kernel/verification.js');

test('attestation oracle requires an observed artifact and structured evidence', () => {
  const slug = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-project-')), 'verify oracle').slug;

  assert.throws(
    () => store.createTicket(slug, { title: 'Missing attestation artifact', executorVerifyKind: 'attestation' }),
    /verifyKind: attestation requires attestationArtifact/,
  );

  const artifact = 'grafana://dashboards/sidequest-overview';
  const ticket = store.createTicket(slug, {
    title: 'Render dashboard',
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: artifact,
  });

  assert.equal(ticket.executorVerifyKind, 'attestation');
  assert.equal(ticket.executorAttestationArtifact, artifact);
  assert.deepStrictEqual(
    store.attestationErrors(`attestation: ${artifact} | provisioned dashboard and 1862px render | all panels rendered with data`, artifact),
    [],
  );
  const descriptiveArtifact = 'Sidequest overview dashboard';
  const descriptiveArtifactError = store.attestationErrors(
    `attestation: ${descriptiveArtifact} | provisioned dashboard and 1862px render | all panels rendered with data`,
    artifact,
  )[0];
  assert.match(descriptiveArtifactError, /first segment must equal attestationArtifact verbatim/);
  assert.ok(descriptiveArtifactError.includes(`Expected prefix: \`attestation: ${artifact} | \`.`));
  assert.ok(descriptiveArtifactError.includes(`Received first segment: \`attestation: ${descriptiveArtifact}\`.`));
  assert.match(
    store.attestationErrors(`attestation: ${artifact} | render`, artifact)[0],
    /evidence produced/,
  );

  const briefing = agentsync.renderTicketBriefing(ticket, 'oracle-token', slug);
  assert.match(briefing, /Legacy verifier: attestation/);
  assert.match(briefing, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(briefing, /Verify output discipline/);
});

test('manual verifier prefixes normalize stored kinds and requirements', () => {
  const slug = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-manual-kind-project-')), 'manual kind').slug;
  const created = store.createTicket(slug, {
    title: 'Normalize a legacy manual verifier',
    executorVerifyKind: 'command',
    executorVerify: 'manual: checked the rendered page',
  });
  assert.equal(created.executorVerifyKind, 'manual');

  const updated = store.updateTicket(slug, created.ref, {
    executorVerifyKind: 'command',
    executorVerify: 'manual: checked the regenerated page',
  });
  assert.equal(updated.executorVerifyKind, 'manual');

  assert.deepStrictEqual(verification.verificationRequirement({
    kind: 'command',
    evidence: 'manual: checked the legacy page',
    command: 'manual: checked the legacy page',
  }), {
    kind: 'manual',
    evidenceContract: 'checked the legacy page',
  });
});

test('verification failures retain domain-specific actionable identities', () => {
  for (const kind of ['document', 'link', 'schema', 'review']) {
    const failure = verification.verificationFailureDiagnostic({
      kind,
      status: 'failed_check',
      evidence: `${kind} evidence did not satisfy the pinned contract`,
      failureIdentities: [`${kind}:pinned-contract`],
    });
    assert.equal(failure.code, 'verification_failed_check');
    assert.match(failure.message, new RegExp(`${kind}:pinned-contract`));
  }
});


test('verification requirements pin suite execution and validate bounded waivers', () => {
  const suite = verification.verificationRequirement({
    kind: 'suite',
    suite: { name: 'sidequest', cwd: 'plugins/sidequest', setup: 'npm ci', command: 'npm run test:full' },
  });
  assert.equal(suite.kind, 'suite');
  assert.equal(suite.command, 'cd plugins/sidequest && npm ci && npm run test:full');
  assert.equal(suite.evidenceContract, 'suite sidequest output');

  const missingWaiver = verification.validateVerificationWaiver(null);
  assert.equal(missingWaiver.code, 'verification_waiver_required');
  const waiver = verification.validateVerificationWaiver({
    authority: 'release-manager',
    reason: 'vendor outage',
    affectedGate: 'docs-link-check',
    scope: 'docs/reference',
  });
  assert.equal(waiver.authority, 'release-manager');
  assert.equal(verification.verificationAccepted({ kind: 'link', status: 'skipped', evidence: waiver.reason, waiver }), true);
  assert.equal(verification.verificationAccepted({ kind: 'link', status: 'skipped', evidence: 'unapproved', waiver: {} }), false);
  assert.equal(verification.verificationAccepted({ kind: 'link', status: 'skipped', evidence: 'unapproved' }), false);
});
