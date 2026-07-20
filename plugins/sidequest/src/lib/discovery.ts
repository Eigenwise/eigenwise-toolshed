import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

interface CatalogSource {
  source: string;
  relPath: string;
  schemas: ReadonlySet<number>;
}

interface CatalogData {
  schemaVersion?: unknown;
  schema?: unknown;
  models?: unknown;
}

interface CatalogModel {
  slug?: unknown;
  id?: unknown;
  label?: unknown;
}

export interface ExternalModel {
  slug: string;
  id: string;
  label: string;
  source: string;
}

export const CATALOG_SOURCES: readonly CatalogSource[] = [
  { source: 'codex-gateway', relPath: path.join('codex-gateway', 'catalog.json'), schemas: new Set([2, 3]) },
];

function discoveryRoots(): string[] {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override?.trim()) {
    return override.split(',').map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
  }
  return [path.join(os.homedir(), '.claude')];
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function catalogModels(data: unknown, schemas: ReadonlySet<number>): unknown[] {
  if (!isRecord(data)) return [];
  const catalog = data as CatalogData;
  const schema = catalog.schemaVersion ?? catalog.schema;
  if (typeof schema !== 'number' || !schemas.has(schema) || !Array.isArray(catalog.models)) return [];
  return catalog.models;
}

function validateEntry(raw: unknown, source: string): ExternalModel | null {
  if (!isRecord(raw)) return null;
  const model = raw as CatalogModel;
  const slug = typeof model.slug === 'string' ? model.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) return null;
  const label = typeof model.label === 'string' && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, source };
}

export function discoverExternalModels(): ExternalModel[] {
  const out: ExternalModel[] = [];
  const seen = new Set<string>();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const models = catalogModels(readJsonSafe(path.join(root, relPath)), schemas);
      for (const raw of models) {
        const entry = validateEntry(raw, source);
        const key = entry && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}
