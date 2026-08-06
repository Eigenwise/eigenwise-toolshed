import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-log-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-log-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const { makeCliRunner } = require('./_helpers.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR });
const { slug } = store.ensureProject(PROJECT_DIR);

function story(title = 'Decision log fixture') {
  return store.createStory(slug, { title });
}

function member(storyRef: string, title = 'Story member') {
  return store.createTicket(slug, { title, storyId: storyRef, source: 'test' });
}

function claim(ref: string, by: string) {
  const result = store.claimTicket(slug, ref, by, { direct: true });
  assert.equal(result.ok, true);
  return result.ticket;
}

function append(storyRef: string, ref: string, by: string, entry: string) {
  return store.appendStoryLogEntry(slug, storyRef, { ref, by, entry });
}

test('append normalizes a one-line entry and records ticket attribution', () => {
  const createdStory = story();
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'store-worker');

  const updated = append(createdStory.ref, ticket.ref, 'store-worker', 'discovery: first line\n second line');
  const log = store.storyDecisionLog(updated);

  assert.equal(log.revision, 1);
  assert.equal(log.entries.length, 1);
  assert.deepEqual(
    { seq: log.entries[0].seq, by: log.entries[0].by, ref: log.entries[0].ref, kind: log.entries[0].kind, text: log.entries[0].text },
    { seq: 1, by: 'store-worker', ref: ticket.ref, kind: 'DISCOVERY', text: 'first line second line' },
  );
  assert.match(log.entries[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('CLI story log reads, appends a body file, and rotates after promotion', () => {
  const createdStory = story('CLI surface');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'cli-worker');
  const entryFile = path.join(SIDEQUEST_HOME, 'story-log-entry.txt');
  fs.writeFileSync(entryFile, 'DISCOVERY: first line\nsecond line', 'utf8');

  const appended = cliJson(['story', 'log', createdStory.ref, '--body-file', entryFile, '--ref', ticket.ref, '--by', 'cli-worker', '--json']);
  assert.equal(appended.story.logRevision, 1);
  assert.equal(appended.story.entries[0].text, 'first line second line');

  const read = cliJson(['story', 'log', createdStory.ref, '--json']);
  assert.equal(read.story.entries.length, 1);
  const rotated = cliJson(['story', 'log', createdStory.ref, '--rotate', '--by', 'orchestrator', '--json']);
  assert.equal(rotated.story.logBytes, 0);
  assert.equal(rotated.story.logCapacity, 4096);
  assert.equal(rotated.story.logRevision, 1);
  assert.deepEqual(rotated.story.entries, []);
  assert.equal(rotated.story.archivedEntries, 1);
  const full = cliJson(['story', 'log', createdStory.ref, '--full', '--json']);
  assert.equal(full.story.entries.length, 1);
  assert.equal(full.story.entries[0].text, 'first line second line');
});

test('append refuses unclaimed, wrong-owner, and non-member ticket attribution', () => {
  const createdStory = story('Claim gate');
  const unclaimed = member(createdStory.ref, 'Unclaimed');
  assert.throws(
    () => append(createdStory.ref, unclaimed.ref, 'worker-a', 'DECISION: held claim required'),
    new RegExp(`story log: ${unclaimed.ref} is not claimed by "worker-a", or it is not a member of ${createdStory.ref}`),
  );

  claim(unclaimed.ref, 'worker-a');
  assert.throws(
    () => append(createdStory.ref, unclaimed.ref, 'worker-b', 'DECISION: owner must match'),
    new RegExp(`story log: ${unclaimed.ref} is not claimed by "worker-b", or it is not a member of ${createdStory.ref}`),
  );

  const otherStory = story('Other story');
  const outsider = member(otherStory.ref, 'Non-member');
  claim(outsider.ref, 'worker-a');
  assert.throws(
    () => append(createdStory.ref, outsider.ref, 'worker-a', 'DECISION: membership required'),
    new RegExp(`story log: ${outsider.ref} is not claimed by "worker-a", or it is not a member of ${createdStory.ref}`),
  );
  assert.equal(store.storyDecisionLog(store.getStory(slug, createdStory.ref)).entries.length, 0);
});

test('orchestrator appends without a member ticket ref through the CLI', () => {
  const createdStory = story('Orchestrator append');
  const explicit = cliJson([
    'story', 'log', createdStory.ref, '-m', 'CONSTRAINT: preserve the public contract', '--by', 'story-planner', '--json',
  ]);
  assert.deepEqual(
    { by: explicit.story.entries[0].by, ref: explicit.story.entries[0].ref, kind: explicit.story.entries[0].kind },
    { by: 'story-planner', ref: null, kind: 'CONSTRAINT' },
  );

  const defaulted = cliJson(['story', 'log', createdStory.ref, '-m', 'DISCOVERY: default attribution works', '--json']);
  assert.ok(defaulted.story.entries[1].by);
  assert.equal(defaulted.story.entries[1].ref, null);

  const read = cliJson(['story', 'log', createdStory.ref, '--json']);
  assert.deepEqual(read.story.entries, defaulted.story.entries);

  const briefing = require('../lib/agentsync.js').renderTicketBriefing({
    ref: 'SQ-briefing', title: 'Briefing member', model: 'opus', effort: 'high', category: {}, storyId: createdStory.id,
  }, 'story-log-token', slug);
  assert.match(briefing, /#1 CONSTRAINT \(orchestrator, story-planner\): preserve the public contract/);
});

test('entries up to 16 KB are stored and long entries advise without blocking', () => {
  const createdStory = story('Entry limit');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'limit-worker');

  const entry = `DISCOVERY: ${'測'.repeat(2000)}`;
  const updated = append(createdStory.ref, ticket.ref, 'limit-worker', entry);
  assert.equal(updated.decisionLog[0].text, '測'.repeat(2000));
  assert.match(store.storyLogEntryAdvisory(entry), /stored in full/);
  assert.throws(
    () => append(createdStory.ref, ticket.ref, 'limit-worker', `DISCOVERY: ${'測'.repeat(6000)}`),
    /story log entry text exceeds the 16000-byte limit/,
  );
});

test('appends beyond the former aggregate limit and defaults reads to the briefing window', () => {
  const createdStory = story('Log capacity');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'capacity-worker');

  for (let index = 0; index < 61; index++) {
    append(createdStory.ref, ticket.ref, 'capacity-worker', `DISCOVERY: ${String(index).padStart(2, '0')} ${'x'.repeat(270)}`);
  }

  const stored = store.getStory(slug, createdStory.ref);
  const log = store.storyDecisionLog(stored);
  assert.equal(stored.logRevision, 61);
  assert.equal(stored.decisionLog.length, 61);
  assert.ok(log.entries.length < 61);
  assert.equal(log.omittedEntries, 61 - log.entries.length);
  assert.equal(log.totalEntries, 61);
  assert.ok(log.bytes <= store.STORY_DECISION_LOG_BRIEFING_MAX_BYTES);
  assert.equal(log.capacity, store.STORY_DECISION_LOG_BRIEFING_MAX_BYTES);
  const shown = cliJson(['story', 'show', createdStory.ref, '--json']);
  assert.equal(shown.story.decisionLog.length, log.entries.length);
  assert.equal(shown.story.decisionLogOmittedEntries, log.omittedEntries);
  assert.equal(shown.story.archivedDecisionLog, undefined);
  const full = cliJson(['story', 'show', createdStory.ref, '--full', '--json']);
  assert.equal(full.story.decisionLog.length, 61);
});

test('briefings retain the newest decision log entries within the 4 KB packet', () => {
  const createdStory = story('Briefing window');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'briefing-worker');

  for (let index = 1; index <= 30; index++) {
    append(createdStory.ref, ticket.ref, 'briefing-worker', `DISCOVERY: ${String(index).padStart(2, '0')} ${'x'.repeat(270)}`);
  }

  const briefing = require('../lib/agentsync.js').renderTicketBriefing({
    ref: ticket.ref, title: ticket.title, model: 'opus', effort: 'high', category: {}, storyId: createdStory.id,
  }, 'story-log-token', slug);
  const packetStart = briefing.indexOf('## Story decision log');
  const packet = briefing.slice(packetStart, briefing.indexOf('## This ticket', packetStart));
  assert.ok(Buffer.byteLength(packet, 'utf8') <= 4096);
  assert.match(packet, /#30 DISCOVERY/);
  assert.doesNotMatch(packet, /#1 DISCOVERY/);
  assert.match(packet, /omitted \d+ earlier entries.*sidequest story log US-\d+ --full/);
});

test('sequence numbers remain monotonic after the log is rotated', () => {
  const createdStory = story('Monotonic sequence');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'sequence-worker');

  append(createdStory.ref, ticket.ref, 'sequence-worker', 'DECISION: first');
  append(createdStory.ref, ticket.ref, 'sequence-worker', 'CONSTRAINT: second');
  const rotated = store.rotateStoryLog(slug, createdStory.ref);
  assert.equal(rotated.logRevision, 2);
  assert.deepEqual(rotated.decisionLog, []);
  assert.equal(rotated.archivedDecisionLog.length, 2);
  const archived = store.storyDecisionLog(rotated, { full: true });
  assert.deepEqual(archived.entries.map((entry: any) => entry.seq), [1, 2]);

  const updated = append(createdStory.ref, ticket.ref, 'sequence-worker', 'DISCOVERY: third');
  assert.equal(updated.logRevision, 3);
  assert.equal(updated.decisionLog[0].seq, 3);
  assert.deepEqual(store.storyDecisionLog(updated, { full: true }).entries.map((entry: any) => entry.seq), [1, 2, 3]);
});

test('claim stamps the current story log sequence', () => {
  const createdStory = story('Claim baseline');
  store.appendStoryLogEntry(slug, createdStory.ref, { by: 'orchestrator', entry: 'DECISION: baseline' });
  const ticket = member(createdStory.ref);

  const claimed = claim(ticket.ref, 'baseline-worker');
  assert.equal(claimed.storyLogSeenSeq, 1);
  assert.equal(store.getTicket(slug, ticket.ref).storyLogSeenSeq, 1);
});

test('derived warnings appear in pulse and changes without touching sibling updatedAt', () => {
  const createdStory = story('Derived drift');
  const writer = member(createdStory.ref, 'Writer');
  const sibling = member(createdStory.ref, 'Sibling');
  claim(writer.ref, 'writer-worker');
  const claimedSibling = claim(sibling.ref, 'sibling-worker');
  const siblingUpdatedAt = claimedSibling.updatedAt;

  append(createdStory.ref, writer.ref, 'writer-worker', 'DISCOVERY: the store payload is live');

  assert.equal(store.getTicket(slug, sibling.ref).updatedAt, siblingUpdatedAt);
  assert.match(store.pulsePayload(slug, sibling.ref).warnings.join('\n'), /decision log gained 1 entry \(#1\) since .* was claimed/);
  const beforeClaim = new Date(Date.parse(siblingUpdatedAt) - 1).toISOString();
  const changedSibling = store.changesPayload(slug, beforeClaim).tickets.find((ticket: any) => ticket.ref === sibling.ref);
  assert.match(changedSibling.warnings.join('\n'), /decision log gained 1 entry/);
  assert.equal(store.changesPayload(slug, siblingUpdatedAt).tickets.some((ticket: any) => ticket.ref === sibling.ref), false);

  const reclaimed = claim(sibling.ref, 'sibling-worker');
  assert.equal(reclaimed.storyLogSeenSeq, 1);
  assert.equal(store.pulsePayload(slug, sibling.ref).warnings, undefined);
  const changedAfterSeen = store.changesPayload(slug, beforeClaim).tickets.find((ticket: any) => ticket.ref === sibling.ref);
  assert.equal(changedAfterSeen.warnings, undefined);
});
