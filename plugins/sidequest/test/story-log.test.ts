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

test('CLI story log reads, appends a body file, and clears after promotion', () => {
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
  const cleared = cliJson(['story', 'log', createdStory.ref, '--clear', '--by', 'orchestrator', '--json']);
  assert.deepEqual(cleared.story, { ref: createdStory.ref, logBytes: 0, logCapacity: 4096, logRevision: 1, entries: [] });
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

test('orchestrator may append without a member ticket ref', () => {
  const createdStory = story('Orchestrator append');
  const updated = store.appendStoryLogEntry(slug, createdStory.ref, {
    by: 'orchestrator',
    entry: 'CONSTRAINT: preserve the public contract',
  });
  assert.deepEqual(
    { by: updated.decisionLog[0].by, ref: updated.decisionLog[0].ref, kind: updated.decisionLog[0].kind },
    { by: 'orchestrator', ref: null, kind: 'CONSTRAINT' },
  );
});

test('entry text over 280 UTF-8 bytes is refused rather than truncated', () => {
  const createdStory = story('Entry limit');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'limit-worker');

  assert.throws(
    () => append(createdStory.ref, ticket.ref, 'limit-worker', `DISCOVERY: ${'測'.repeat(94)}`),
    /story log entry text exceeds the 280-byte limit/,
  );
  assert.equal(store.storyDecisionLog(store.getStory(slug, createdStory.ref)).entries.length, 0);
});

test('rendered decision log refuses entries beyond 4096 bytes without eviction', () => {
  const createdStory = story('Log capacity');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'capacity-worker');

  let refusal: Error | null = null;
  for (let index = 0; index < 100 && !refusal; index++) {
    try {
      append(createdStory.ref, ticket.ref, 'capacity-worker', `DISCOVERY: ${String(index).padStart(2, '0')} ${'x'.repeat(270)}`);
    } catch (error: any) {
      refusal = error;
    }
  }

  assert.ok(refusal);
  const stored = store.getStory(slug, createdStory.ref);
  const log = store.storyDecisionLog(stored);
  assert.match(
    refusal?.message || '',
    new RegExp(`^story log: ${createdStory.ref} decision log is full \\(4096 bytes, ${log.entries.length} entries\\)\\. Condense it into the story execution contract with story_contract, then clear with story_log --clear\\.$`),
  );
  assert.ok(log.bytes <= store.STORY_DECISION_LOG_MAX_BYTES);
  assert.equal(stored.logRevision, log.entries.length);
});

test('sequence numbers remain monotonic after the log is cleared', () => {
  const createdStory = story('Monotonic sequence');
  const ticket = member(createdStory.ref);
  claim(ticket.ref, 'sequence-worker');

  append(createdStory.ref, ticket.ref, 'sequence-worker', 'DECISION: first');
  append(createdStory.ref, ticket.ref, 'sequence-worker', 'CONSTRAINT: second');
  const cleared = store.clearStoryLog(slug, createdStory.ref);
  assert.equal(cleared.logRevision, 2);
  assert.deepEqual(cleared.decisionLog, []);

  const updated = append(createdStory.ref, ticket.ref, 'sequence-worker', 'DISCOVERY: third');
  assert.equal(updated.logRevision, 3);
  assert.equal(updated.decisionLog[0].seq, 3);
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
