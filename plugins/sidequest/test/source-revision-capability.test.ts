import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceRevisionCapability = require('../src/lib/source-revision-capability.ts');
const { filesystemSnapshotLimitGuidance } = require('../src/lib/refusal-guidance.ts');

const candidate = Object.freeze({ source: 'git', value: 'delivered-commit', observedAt: '2026-08-14T00:00:00.000Z' });
const integrationBaseline = Object.freeze({
  revision: Object.freeze({ source: 'git', value: 'current-integration-tip', observedAt: '2026-08-14T00:01:00.000Z' }),
  purpose: 'submission',
});
const observedAt = '2026-08-14T00:00:00.000Z';

function withSnapshotProject(run: (projectPath: string) => void): void {
  const projectPath = mkdtempSync(join(tmpdir(), 'sq-source-revision-'));
  try {
    run(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

function expectSnapshotLimit(
  run: () => unknown,
  bound: string,
  observed: number,
  cap: number,
): void {
  assert.throws(run, (error: unknown) => {
    assert.equal(sourceRevisionCapability.isFilesystemSnapshotLimitError(error), true);
    assert.equal((error as { bound: string }).bound, bound);
    assert.equal((error as { observed: number }).observed, observed);
    assert.equal((error as { cap: number }).cap, cap);
    return true;
  });
}

test('source revision capability resolves the current integration revision at action time', () => {
  const project = `source-revision-current-tip-${process.pid}-${Date.now()}`;
  let currentIntegrationTip = 'previous-integration-tip';
  const unregister = sourceRevisionCapability.registerSourceRevisionCapability(project, (resolvedCandidate: any, baseline: any) => ({
    candidateExists: resolvedCandidate.value === candidate.value,
    containsCandidate: baseline.revision.value === currentIntegrationTip,
  }));
  try {
    currentIntegrationTip = integrationBaseline.revision.value;
    const facts = sourceRevisionCapability.sourceRevisionAdapterFacts(project, candidate, integrationBaseline);
    assert.ok(facts, 'the authority returns a branded immutable resolution');
    assert.equal(facts.baseline?.candidateExists, true, 'the authority resolves the delivered candidate');
    assert.equal(facts.baseline?.containsCandidate, true, 'the authority uses the integration tip available at closure time');
    assert.deepEqual(facts.dispatchBaseline, integrationBaseline, 'the closure retains the exact integration revision it checked');
    assert.equal(sourceRevisionCapability.isSourceRevisionAdapterFacts(facts), true, 'only authority-produced facts can cross the lifecycle boundary');
  } finally {
    unregister();
  }
});

test('filesystem snapshot refuses a tree over its path cap', () => {
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, 'first.txt'), 'a');
    writeFileSync(join(projectPath, 'second.txt'), 'b');

    expectSnapshotLimit(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { maxPaths: 2 }),
      'path cap',
      3,
      2,
    );
  });
});

test('filesystem snapshot refuses a tree over its byte cap', () => {
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, 'contents.txt'), 'four');

    expectSnapshotLimit(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { maxBytes: 3 }),
      'byte cap',
      4,
      3,
    );
  });
});

test('filesystem snapshot refuses when a read exceeds its deadline', () => {
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, 'contents.txt'), 'a');
    let now = 0;

    expectSnapshotLimit(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, {
        maxElapsedMs: 4,
        now: () => now,
        readFile: (entryPath: string) => {
          now = 5;
          return readFileSync(entryPath);
        },
      }),
      'deadline',
      5,
      4,
    );
  });
});

test('filesystem snapshot keeps the existing digest for a fixture under every cap', () => {
  withSnapshotProject((projectPath) => {
    mkdirSync(join(projectPath, 'nested'));
    writeFileSync(join(projectPath, 'alpha.txt'), 'alpha\n');
    writeFileSync(join(projectPath, 'nested', 'beta.txt'), 'beta\n');

    const revision = sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt);

    assert.equal(revision?.value, '3bf755d3a37c72fc984a857d4bb769cae4dcf70e3d1fcacbcbed6ab41afada9c');
  });
});

test('filesystem snapshot cap guidance names the bound and recourse', () => {
  const guidance = filesystemSnapshotLimitGuidance('/project', { bound: 'path cap', observed: 501, cap: 500 });

  assert.match(guidance, /path cap reached 501 paths; cap 500 paths/);
  assert.match(guidance, /Initialize a git repository at the project root/);
  assert.match(guidance, /point the board at a smaller directory/);
});
