import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest } from '../src/lib/freshness.ts';
import type { IndexBuildResult } from '../src/lib/index-builder.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { GraphStore } from '../src/lib/store.ts';

test('index publishes a ready zero-fact snapshot', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-'));
  try {
    const service = new CodegraphService({
      projectRoot,
      store: GraphStore.open(':memory:'),
      runtime: { acquire: async () => ({ engineId: 'test-engine', engineVersion: '1.0.0', extractors: [] }) },
      index: async (root): Promise<IndexBuildResult> => ({ snapshots: [], manifest: await buildRelevantInputManifest(root) }),
    });
    const indexed = await service.index();
    assert.equal(indexed.status, 'ready');
    assert.equal(indexed.results.length, 0);
    const status = await service.status();
    assert.equal(status.status, 'ready');
    assert.equal(status.coverage?.files, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
