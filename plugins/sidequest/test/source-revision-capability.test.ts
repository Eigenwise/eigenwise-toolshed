import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceRevisionCapability = require('../src/lib/source-revision-capability.ts');
const { filesystemSnapshotLimitGuidance, filesystemSnapshotChildFailureGuidance } = require('../src/lib/refusal-guidance.ts');

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

// No fixture tree can hold a file whose read never returns, so the block is injected at the child's
// reader seam: an Atomics.wait with no timeout is the same uninterruptible synchronous block a
// files-on-demand placeholder hydration is, and it leaves no OS resource behind to clean up.
function withBlockingSnapshotChild(blockingFile: string, run: (childScript: string) => void): void {
  const scriptDirectory = mkdtempSync(join(tmpdir(), 'sq-snapshot-child-'));
  const childScript = join(scriptDirectory, 'blocking-child.cjs');
  const childModule = join(__dirname, '..', 'src', 'lib', 'source-revision-snapshot-child.ts');
  writeFileSync(childScript, [
    `const { runSnapshotChild } = require(${JSON.stringify(childModule)});`,
    `const blockingFile = ${JSON.stringify(blockingFile)};`,
    'runSnapshotChild(process.argv[2], (entryPath) => {',
    '  if (!entryPath.endsWith(blockingFile)) return require("node:fs").readFileSync(entryPath);',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '  return Buffer.alloc(0);',
    '});',
  ].join('\n'));
  try {
    run(childScript);
  } finally {
    rmSync(scriptDirectory, { recursive: true, force: true });
  }
}

function withSnapshotChildScript(source: string, run: (childScript: string) => void): void {
  const scriptDirectory = mkdtempSync(join(tmpdir(), 'sq-snapshot-child-'));
  const childScript = join(scriptDirectory, 'child.cjs');
  writeFileSync(childScript, source);
  try {
    run(childScript);
  } finally {
    rmSync(scriptDirectory, { recursive: true, force: true });
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

// Its own timeout: before the snapshot walk moved out of process this call never returned at all,
// so a regression here has to fail rather than wedge the whole suite.
test('filesystem snapshot refuses a read that never returns and names the blocking file', { timeout: 60_000 }, () => {
  const maxElapsedMs = 1_500;
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, 'alpha.txt'), 'alpha\n');
    writeFileSync(join(projectPath, 'blocking.txt'), 'never read\n');

    withBlockingSnapshotChild('blocking.txt', (childScript) => {
      const startedAt = Date.now();
      assert.throws(
        () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { maxElapsedMs, childScript }),
        (error: unknown) => {
          assert.equal(sourceRevisionCapability.isFilesystemSnapshotLimitError(error), true);
          assert.equal((error as { bound: string }).bound, 'deadline');
          assert.equal((error as { cap: number }).cap, maxElapsedMs);
          assert.ok((error as { observed: number }).observed >= maxElapsedMs, 'the refusal reports the elapsed wall clock');
          assert.equal((error as { path: string | null }).path, 'blocking.txt', 'the refusal names the file the read hung on');
          assert.match((error as Error).message, /while reading blocking\.txt/);
          return true;
        },
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < maxElapsedMs * 3, `the refusal arrived within its wall clock, not after ${elapsedMs}ms`);
    });
  });
});

test('filesystem snapshot still bounds a zero wall clock', { timeout: 60_000 }, () => {
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, 'contents.txt'), 'a');

    assert.throws(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { maxElapsedMs: 0 }),
      (error: unknown) => {
        assert.equal((error as { bound: string }).bound, 'deadline');
        assert.equal((error as { cap: number }).cap, 0);
        return true;
      },
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
  assert.match(guidance, /leaves out \.git, installed and build output directories/);
  assert.match(guidance, /switches to git on its next dispatch once a \.git exists/);
});

function writeFiles(directory: string, count: number): void {
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) writeFileSync(join(directory, `file-${index}.js`), `module.exports = ${index};\n`);
}

// GH-334: a 19-file repository refused dispatch at 501 paths because the walk counted .git and
// node_modules. The digest must also ignore them, or an install would read as a source change.
test('filesystem snapshot never counts .git and skips a 1000-file node_modules under the default cap', () => {
  withSnapshotProject((projectPath) => {
    writeFiles(join(projectPath, 'src'), 19);
    const sourceOnly = sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt);

    writeFiles(join(projectPath, 'node_modules', 'left-pad'), 1000);
    writeFiles(join(projectPath, '.git', 'objects'), 600);
    for (const name of ['.next', 'dist', 'build', 'target', '.venv', 'vendor']) writeFiles(join(projectPath, name), 2);
    writeFiles(join(projectPath, 'src', 'node_modules'), 2);

    const withGenerated = sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt);

    assert.equal(withGenerated?.value, sourceOnly?.value);
  });
});

test('filesystem snapshot skips what the root .gitignore excludes', () => {
  withSnapshotProject((projectPath) => {
    writeFileSync(join(projectPath, '.gitignore'), '# generated\n\ncoverage/\n*.log\n/out\n!keep.log\n');
    writeFiles(join(projectPath, 'src'), 3);
    const sourceOnly = sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt);

    writeFiles(join(projectPath, 'coverage'), 20);
    writeFiles(join(projectPath, 'src', 'coverage'), 20);
    writeFileSync(join(projectPath, 'debug.log'), 'noise\n');
    writeFileSync(join(projectPath, 'src', 'trace.log'), 'noise\n');
    writeFiles(join(projectPath, 'out'), 20);

    assert.equal(sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt)?.value, sourceOnly?.value);

    writeFiles(join(projectPath, 'src', 'out'), 1);
    const withNestedOut = sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt);
    assert.notEqual(withNestedOut?.value, sourceOnly?.value, 'the anchored /out pattern leaves src/out counted');

    mkdirSync(join(projectPath, 'notes'));
    writeFileSync(join(projectPath, 'notes', 'coverage'), 'a file, not a coverage/ directory\n');
    assert.notEqual(
      sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt)?.value,
      withNestedOut?.value,
      'the directory-only coverage/ pattern leaves a file named coverage counted',
    );
  });
});

test('filesystem snapshot path cap refusal names what the walk skipped and counted', () => {
  withSnapshotProject((projectPath) => {
    writeFiles(join(projectPath, 'src'), 6);
    writeFiles(join(projectPath, 'docs'), 2);
    writeFiles(join(projectPath, 'node_modules'), 3);
    writeFiles(join(projectPath, '.git'), 3);

    assert.throws(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { maxPaths: 9 }),
      (error: unknown) => {
        const walk = (error as { walk: { skipped: string[]; skippedTotal: number; counted: Array<{ path: string; paths: number }> } }).walk;
        assert.equal((error as { bound: string }).bound, 'path cap');
        assert.deepEqual(walk.skipped, ['.git', 'node_modules']);
        assert.equal(walk.skippedTotal, 2);
        assert.deepEqual(walk.counted, [{ path: 'src', paths: 6 }, { path: 'docs', paths: 3 }, { path: '.', paths: 1 }]);
        const guidance = filesystemSnapshotLimitGuidance(projectPath, error as never);
        assert.match(guidance, /This walk skipped \.git, node_modules; the most paths it counted were under src \(6\), docs \(3\), \. \(1\)\./);
        return true;
      },
    );
  });
});

test('filesystem snapshot of a missing project root keeps its fixed digest', () => {
  withSnapshotProject((projectPath) => {
    const revision = sourceRevisionCapability.filesystemSnapshotRevision(join(projectPath, 'not-created-yet'), observedAt);

    assert.equal(revision?.value, '9c5250c3567577c02831e4ea907d81a08d81ccf52a80da0b321b4ff6ebc0b6f4');
  });
});

test('filesystem snapshot guidance reports an empty skip and truncates a long one', () => {
  const counted = [{ path: 'src', paths: 501 }];
  const nothingSkipped = filesystemSnapshotLimitGuidance('/project', {
    bound: 'path cap', observed: 501, cap: 500, walk: { skipped: [], skippedTotal: 0, counted },
  });
  const manySkipped = filesystemSnapshotLimitGuidance('/project', {
    bound: 'path cap', observed: 501, cap: 500, walk: { skipped: ['a/node_modules', 'b/node_modules'], skippedTotal: 12, counted },
  });

  assert.match(nothingSkipped, /This walk skipped nothing; the most paths it counted were under src \(501\)\./);
  assert.match(manySkipped, /This walk skipped a\/node_modules, b\/node_modules, and 10 more;/);
});

test('filesystem snapshot child that cannot run is reported as a child failure, not an unreadable project', () => {
  withSnapshotProject((projectPath) => {
    const childScript = join(mkdtempSync(join(tmpdir(), 'sq-snapshot-missing-')), 'does-not-exist.cjs');

    assert.throws(
      () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { childScript }),
      (error: unknown) => {
        assert.equal(sourceRevisionCapability.isFilesystemSnapshotChildError(error), true);
        const guidance = filesystemSnapshotChildFailureGuidance(error as { kind: string });
        assert.match(guidance, /snapshot child/);
        assert.doesNotMatch(guidance, /Retry dispatch after the project is readable/);
        return true;
      },
    );
  });
});

test('filesystem snapshot child that exits non-zero reports the status and a bounded stderr excerpt', () => {
  withSnapshotProject((projectPath) => {
    withSnapshotChildScript(
      ['process.stderr.write("child crashed while walking the tree\\n");', 'process.exitCode = 7;'].join('\n'),
      (childScript) => {
        assert.throws(
          () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { childScript }),
          (error: unknown) => {
            assert.equal(sourceRevisionCapability.isFilesystemSnapshotChildError(error), true);
            assert.equal((error as { kind: string }).kind, 'exit-status');
            assert.equal((error as { status: number }).status, 7);
            assert.match((error as { stderr: string }).stderr, /child crashed while walking the tree/);
            const guidance = filesystemSnapshotChildFailureGuidance(error as { kind: string; status: number; stderr: string });
            assert.match(guidance, /exited with status 7/);
            assert.match(guidance, /child crashed while walking the tree/);
            return true;
          },
        );
      },
    );
  });
});

test('filesystem snapshot child that exits clean but prints non-JSON reports an unparseable result', () => {
  withSnapshotProject((projectPath) => {
    withSnapshotChildScript('process.stdout.write("not json");', (childScript) => {
      assert.throws(
        () => sourceRevisionCapability.filesystemSnapshotRevision(projectPath, observedAt, { childScript }),
        (error: unknown) => {
          assert.equal(sourceRevisionCapability.isFilesystemSnapshotChildError(error), true);
          assert.equal((error as { kind: string }).kind, 'unparseable');
          const guidance = filesystemSnapshotChildFailureGuidance(error as { kind: string });
          assert.match(guidance, /could not be parsed/);
          assert.doesNotMatch(guidance, /Retry dispatch after the project is readable/);
          return true;
        },
      );
    });
  });
});

// Regression control: a genuinely unreadable project root (not a directory at all) is the one
// case where the existing "retry after the project is readable" wording is correct, and it must
// not drift.
test('filesystem snapshot of a genuinely unreadable project returns null, not a child failure', () => {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'sq-snapshot-unreadable-'));
  const notADirectory = join(parentDirectory, 'project-path-is-a-file');
  writeFileSync(notADirectory, 'not a project root');

  try {
    const revision = sourceRevisionCapability.filesystemSnapshotRevision(notADirectory, observedAt);
    assert.equal(revision, null);
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true });
  }
});

test('filesystem snapshot deadline guidance names the blocking file and a non-synced directory', () => {
  const guidance = filesystemSnapshotLimitGuidance('/project', {
    bound: 'deadline',
    observed: 10_004,
    cap: 10_000,
    path: 'docs/spec.pdf',
  });

  assert.match(guidance, /deadline reached 10004 ms; cap 10000 ms/);
  assert.match(guidance, /reading docs\/spec\.pdf when the clock ran out/);
  assert.match(guidance, /Initialize a git repository at the project root/);
  assert.match(guidance, /point the board at a local directory no sync client mirrors/);
});
