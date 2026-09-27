import { spawnSync } from 'node:child_process';
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
  updatedAt?: unknown;
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
  efforts?: string[];
}

// Codex desktop execution does not use model-gateway. A local operator verifies
// the picker/model availability and records it here; a missing, stale, or
// malformed declaration never becomes an executable route.
const NATIVE_CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const NATIVE_CODEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function nativeCodexCatalogPath(): string {
  return path.join(process.env.SIDEQUEST_HOME || path.join(claudeHome(), 'sidequest'), 'native-codex-models.json');
}

export function nativeCodexCatalog(): { ok: boolean; reason: string; models: ExternalModel[] } {
  const raw = readCatalogSafe(nativeCodexCatalogPath());
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.models)
    || typeof raw.attestedBy !== 'string' || !raw.attestedBy.trim()
    || typeof raw.verifiedAt !== 'string') return { ok: false, reason: 'missing or malformed operator attestation', models: [] };
  const age = Date.now() - Date.parse(raw.verifiedAt);
  if (!Number.isFinite(age) || age < -5 * 60 * 1000 || age > NATIVE_CODEX_MAX_AGE_MS) {
    return { ok: false, reason: 'operator attestation is expired or future-dated', models: [] };
  }
  const models: ExternalModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.models) {
    if (!isRecord(entry) || typeof entry.slug !== 'string' || !/^native-codex-[a-z0-9-]{2,19}$/.test(entry.slug)
      || typeof entry.id !== 'string' || !/^gpt-[a-z0-9.-]{2,31}$/.test(entry.id)
      || typeof entry.label !== 'string' || !entry.label.trim()
      || !Array.isArray(entry.efforts) || !entry.efforts.length
      || entry.efforts.some((effort) => !NATIVE_CODEX_EFFORTS.has(effort))
      || seen.has(entry.slug)) return { ok: false, reason: 'invalid or duplicate native model declaration', models: [] };
    seen.add(entry.slug);
    models.push({ slug: entry.slug, id: entry.id, label: entry.label.trim(), provider: 'codex', source: 'codex-native', efforts: entry.efforts.slice() });
  }
  return models.length ? { ok: true, reason: 'operator-attested', models }
    : { ok: false, reason: 'no native models declared', models: [] };
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

function claudeHome(): string {
  return path.resolve(process.env.SIDEQUEST_CLAUDE_HOME || path.join(os.homedir(), '.claude'));
}

function discoveryRoots(): string[] {
  const defaultRoot = claudeHome();
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (!override?.trim()) return [defaultRoot];
  return [...override.split(',').map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value)), defaultRoot]
    .filter((root, index, roots) => roots.indexOf(root) === index);
}

// Only the installed gateway catalog has a writer, so only it is held to the freshness window; a catalog
// under an extra discovery root is read as recorded. The window still applies when the gateway plugin is
// gone: a leftover catalog must not advertise routes nothing can serve.
function installedGatewayCatalog(catalogPath: string): boolean {
  return path.resolve(catalogPath) === path.join(claudeHome(), 'model-gateway', 'catalog.json');
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

interface CachedCatalog {
  fingerprint: string | null;
  data: unknown;
}

const catalogCache = new Map<string, CachedCatalog>();

function catalogFileFingerprint(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readCatalogSafe(file: string): unknown {
  const resolvedFile = path.resolve(file);
  const fingerprint = catalogFileFingerprint(resolvedFile);
  const cached = catalogCache.get(resolvedFile);
  if (cached?.fingerprint === fingerprint) return cached.data;
  const data = readJsonSafe(resolvedFile);
  catalogCache.set(resolvedFile, { fingerprint, data });
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function versionParts(version: unknown): [number, number, number] | null {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerVersion(candidate: [number, number, number], current: [number, number, number]): boolean {
  for (const index of [0, 1, 2] as const) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

function newestGatewayCatalogCommand(): string | null {
  const registry = readJsonSafe(path.join(claudeHome(), 'plugins', 'installed_plugins.json'));
  if (!isRecord(registry) || !isRecord(registry.plugins)) return null;
  const entries = registry.plugins['model-gateway@eigenwise-toolshed'];
  if (!Array.isArray(entries)) return null;
  let newest: { command: string; version: [number, number, number] } | null = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== 'string') continue;
    const version = versionParts(entry.version);
    const command = path.join(entry.installPath, 'bin', 'model-gateway.js');
    if (!version || !fs.existsSync(command) || (newest && !isNewerVersion(version, newest.version))) continue;
    newest = { command, version };
  }
  return newest?.command ?? null;
}

function gatewayRefreshSucceeded(command: string): boolean {
  try {
    return spawnSync(process.execPath, [command, 'catalog', '--refresh', '--json'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).status === 0;
  } catch {
    return false;
  }
}

export const CATALOG_STALE_MS = 5 * 60 * 1000;
// A refresh that fails is retried soon rather than pinned for the whole catalog window, but not on every call:
// a gateway that is down would otherwise spawn a child process per route resolution.
const REFRESH_RETRY_MS = 30 * 1000;

const gatewayRefreshAttempts = new Map<string, { at: number; refreshed: boolean }>();

// Run the refresh for its side effect and re-read the file to get the written catalog. Parsing the gateway
// CLI's stdout made this return null the moment that CLI printed a diagnostic line ahead of the JSON, so the
// refresh silently did nothing in the exact case it exists for (SQ-2208). The exit code is the authority now:
// it exits non-zero with a stderr reason when it declines to write, so a 0 means the catalog file is current
// and safe to read back. Attempts are remembered per catalog file, so readiness and model listing share one
// child process rather than spawning one each.
function refreshGatewayCatalog(catalogPath: string): CatalogData | null {
  if (!installedGatewayCatalog(catalogPath)) return null;
  const attempt = gatewayRefreshAttempts.get(catalogPath);
  const window = attempt?.refreshed ? CATALOG_STALE_MS : REFRESH_RETRY_MS;
  if (!attempt || Date.now() - attempt.at > window) {
    const command = newestGatewayCatalogCommand();
    const written = command !== null && gatewayRefreshSucceeded(command) ? readCatalogSafe(catalogPath) : null;
    gatewayRefreshAttempts.set(catalogPath, { at: Date.now(), refreshed: catalogWithinFreshnessWindow(written) });
    return isRecord(written) ? written as CatalogData : null;
  }
  const catalog = attempt.refreshed ? readCatalogSafe(catalogPath) : null;
  return isRecord(catalog) ? catalog as CatalogData : null;
}

function catalogWithinFreshnessWindow(data: unknown): boolean {
  if (!isRecord(data) || typeof data.updatedAt !== 'string') return false;
  const age = Date.now() - Date.parse(data.updatedAt);
  return Number.isFinite(age) && age >= 0 && age <= CATALOG_STALE_MS;
}

export function catalogStateFingerprint(): string {
  const nativePath = nativeCodexCatalogPath();
  const native = nativeCodexCatalog();
  return [...discoveryRoots().flatMap((root) => CATALOG_SOURCES.map(({ relPath }) => {
    const catalogPath = path.resolve(root, relPath);
    const freshness = !installedGatewayCatalog(catalogPath) || catalogWithinFreshnessWindow(readCatalogSafe(catalogPath)) ? 'fresh' : 'stale';
    return `${catalogPath}:${catalogFileFingerprint(catalogPath) ?? 'missing'}:${freshness}`;
  })), `${nativePath}:${catalogFileFingerprint(nativePath) ?? 'missing'}:${native.ok ? 'fresh' : native.reason}`].join('|');
}

function usableCatalog(data: unknown, schemas: ReadonlySet<number>, catalogPath: string): CatalogData | null {
  if (!isRecord(data) || (installedGatewayCatalog(catalogPath) && !catalogWithinFreshnessWindow(data))) return null;
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

function catalogProviderReadiness(catalog: CatalogData, provider: string): ProviderReadiness | null {
  const schema = catalogSchema(catalog);
  const readiness = schema >= 4
    ? isRecord(catalog.providers) && validateReadiness(catalog.providers[provider])
    : provider === 'codex' && validateReadiness(catalog.codexReadiness);
  return readiness ? { provider, ...readiness } : null;
}

export function providerReadiness(provider: string): ProviderReadiness | null {
  for (const root of discoveryRoots()) {
    for (const { relPath, schemas } of CATALOG_SOURCES) {
      const catalogPath = path.join(root, relPath);
      const storedCatalog = readCatalogSafe(catalogPath);
      let catalog = usableCatalog(storedCatalog, schemas, catalogPath);
      let readiness = catalog && catalogProviderReadiness(catalog, provider);
      if (provider === 'codex' && isRecord(storedCatalog) && (!catalog || !readiness?.ready)) {
        const refreshedCatalog = usableCatalog(refreshGatewayCatalog(catalogPath), schemas, catalogPath);
        if (refreshedCatalog) {
          catalog = refreshedCatalog;
          readiness = catalogProviderReadiness(catalog, provider);
        }
      }
      if (readiness) return readiness;
    }
  }
  return null;
}

function currentCatalog(catalogPath: string, schemas: ReadonlySet<number>): CatalogData | null {
  const storedCatalog = readCatalogSafe(catalogPath);
  const usable = usableCatalog(storedCatalog, schemas, catalogPath);
  if (usable || !isRecord(storedCatalog)) return usable;
  return usableCatalog(refreshGatewayCatalog(catalogPath), schemas, catalogPath);
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

export function configuredExternalModelProvider(slug: string): string | null {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalizedSlug)) return null;
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(path.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models as unknown[]) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        if (entry?.slug === normalizedSlug) return entry.provider;
      }
    }
  }
  return null;
}

export function discoverExternalModels(): ExternalModel[] {
  const out: ExternalModel[] = [];
  const seen = new Set<string>();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(path.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models as unknown[]) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        const readiness = entry && catalogProviderReadiness(catalog, entry.provider);
        const key = entry && readiness?.ready && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}
