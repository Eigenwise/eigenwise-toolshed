import fs from 'node:fs';
import path from 'node:path';
import { beforeEach } from 'node:test';
import { CATALOG_SOURCES } from '../src/lib/discovery.js';

// A model-gateway catalog older than CATALOG_STALE_MS reads as absent, so a fixture catalog stamped once
// at module load stops counting partway through a long file: on windows-latest, mcp.test.ts crossed the
// five-minute line mid-suite and every codex route in it began refusing with "model-gateway readiness is
// unavailable", failing two scope tests that never mentioned a provider (SQ-2199). Re-stamping keeps what
// a test proves tied to the catalog it seeded instead of to how long the suite has been running.
//
// A file that asserts staleness itself (test/discovery.test.ts) must NOT import this.
function discoveryRoots(): string[] {
  return (process.env.SIDEQUEST_DISCOVERY_DIRS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function catalogObject(file: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function restampSeededCatalogs() {
  for (const root of discoveryRoots()) {
    for (const source of CATALOG_SOURCES) {
      const file = path.join(root, source.relPath);
      const catalog = catalogObject(file);
      if (!catalog) continue;
      catalog.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(catalog));
    }
  }
}

beforeEach(restampSeededCatalogs);
