import { describe, expect, it } from 'vitest';
import { contextWindowNotes, discoveredModels, modelOptionLabel } from '../app/src/lib/components/settings/model-windows';

const codexNote = 'OpenAI bills input above 272k tokens at 2x; the cap keeps every request, including compaction, under it';

describe('model picker context windows', () => {
  const discovered = discoveredModels([
    { slug: 'codex-gpt-sol', provider: 'codex', contextWindow: 272000, contextWindowNote: codexNote },
    { slug: 'codex-gpt-terra', provider: 'codex', contextWindow: 272000, contextWindowNote: codexNote },
    { slug: 'grok-fast', provider: 'grok', contextWindow: 500000 },
    { slug: 'codex-gpt-old' },
    null,
    'stray',
  ]);

  it('keeps only object rows from the served catalog', () => {
    expect(discovered.map((model) => model.slug)).toEqual(['codex-gpt-sol', 'codex-gpt-terra', 'grok-fast', 'codex-gpt-old']);
    expect(discoveredModels(undefined)).toEqual([]);
  });

  it('labels a discovered model with its window and leaves other models plain', () => {
    expect(modelOptionLabel('codex-gpt-sol', discovered)).toBe('codex-gpt-sol · 272k window');
    expect(modelOptionLabel('grok-fast', discovered)).toBe('grok-fast · 500k window');
    expect(modelOptionLabel('codex-gpt-old', discovered)).toBe('codex-gpt-old');
    expect(modelOptionLabel('sonnet', discovered)).toBe('sonnet');
  });

  it('shows each billing explanation once', () => {
    expect(contextWindowNotes(discovered)).toEqual([`codex · 272k window: ${codexNote}`]);
  });
});
