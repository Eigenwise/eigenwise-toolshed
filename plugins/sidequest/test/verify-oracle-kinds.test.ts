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
  assert.match(
    store.attestationErrors(`attestation: ${artifact} | render`, artifact)[0],
    /evidence produced/,
  );

  const briefing = agentsync.renderTicketBriefing(ticket, 'oracle-token', slug);
  assert.match(briefing, /Verify oracle: attestation/);
  assert.match(briefing, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(briefing, /Verify output discipline/);
});
