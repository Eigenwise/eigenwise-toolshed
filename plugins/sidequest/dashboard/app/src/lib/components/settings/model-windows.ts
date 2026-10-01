import type { JsonRecord } from '../../types';

function windowSize(value: unknown) {
  return typeof value === 'number' ? `${Math.round(value / 1000)}k` : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object';
}

function hasContextWindowNote(model: JsonRecord) {
  return typeof model.contextWindowNote === 'string' && model.contextWindowNote !== '';
}

export function discoveredModels(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function modelOptionLabel(slug: string, discovered: JsonRecord[]) {
  const size = windowSize(discovered.find((model) => model.slug === slug)?.contextWindow);
  return size ? `${slug} · ${size} window` : slug;
}

export function contextWindowNotes(discovered: JsonRecord[]) {
  const notes = discovered
    .filter(hasContextWindowNote)
    .map((model) => `${String(model.provider ?? '')} · ${windowSize(model.contextWindow)} window: ${model.contextWindowNote}`);
  return [...new Set(notes)];
}
