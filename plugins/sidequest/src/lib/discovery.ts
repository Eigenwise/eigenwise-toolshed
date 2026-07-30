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
  providers?: unknown;
  codexReadiness?: unknown;
}

interface CatalogModel {
  slug?: unknown;
  id?: unknown;
  label?: unknown;
  provider?: unknown;
}

export interface ExternalModel {
  slug: string;
  id: string;
  label: string;
  provider: string;
  source: string;
}

export interface ProviderReadiness {
  provider: string;
  ready: boolean;
  state: string;
  message: string;
}

export const CATALOG_SOURCES: readonly CatalogSource[] = [
  { source: 'model-gateway', relPath: path.join('model-gateway', 'catalog.json'), schemas: new Set([2, 3, 4]) },
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

function validCatalog(data: unknown, schemas: ReadonlySet<number>): CatalogData | null {
  if (!isRecord(data)) return null;
  const catalog = data as CatalogData;
  const schema = catalog.schemaVersion ?? catalog.schema;
  return typeof schema === 'number' && schemas.has(schema) && Array.isArray(catalog.models) ? catalog : null;
}

function catalogSchema(catalog: CatalogData): number {
  return (catalog.schemaVersion ?? catalog.schema) as number;
}

function validateReadiness(raw: unknown): Omit<ProviderReadiness, 'provider'> | null {
  if (!isRecord(raw) || typeof raw.ready !== 'boolean') return null;
  const state = typeof raw.state === 'string' ? raw.state.trim() : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  return state && message ? { ready: raw.ready, state, message } : null;
}

export function providerReadiness(provider: string): ProviderReadiness | null {
  for (const root of discoveryRoots()) {
    for (const { relPath, schemas } of CATALOG_SOURCES) {
      const catalog = validCatalog(readJsonSafe(path.join(root, relPath)), schemas);
      if (!catalog) continue;
      const schema = catalogSchema(catalog);
      const readiness = schema >= 4
        ? isRecord(catalog.providers) && validateReadiness(catalog.providers[provider])
        : provider === 'codex' && validateReadiness(catalog.codexReadiness);
      if (readiness) return { provider, ...readiness };
    }
  }
  return null;
}

function validateEntry(raw: unknown, source: string, schema: number): ExternalModel | null {
  if (!isRecord(raw)) return null;
  const model = raw as CatalogModel;
  const slug = typeof model.slug === 'string' ? model.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) return null;
  const provider = schema >= 4
    ? typeof model.provider === 'string' && model.provider === model.provider.toLowerCase() && SLUG_RE.test(model.provider) ? model.provider : ''
    : 'codex';
  if (!provider) return null;
  const label = typeof model.label === 'string' && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, provider, source };
}

export function discoverExternalModels(): ExternalModel[] {
  const out: ExternalModel[] = [];
  const seen = new Set<string>();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = validCatalog(readJsonSafe(path.join(root, relPath)), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models as unknown[]) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        const key = entry && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}
