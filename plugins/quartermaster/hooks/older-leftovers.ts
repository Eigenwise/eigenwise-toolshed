import type { SettingsFile } from './older-gateway'

// A plugin this version also ships updates in place, so an older version of it gets no line here, observability included.
export const OLDER_ONLY_PLUGIN_NAMES = ['quality-gate', 'model-gateway'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function enabledPluginsIn(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    const enabled = isRecord(parsed) ? parsed.enabledPlugins : undefined

    return isRecord(enabled) ? enabled : {}
  } catch {
    return {}
  }
}

export function olderOnlyPluginsOn(files: readonly SettingsFile[]): string[] {
  const enabled = files.map(file => enabledPluginsIn(file.text))

  return OLDER_ONLY_PLUGIN_NAMES.filter(name => enabled.some(plugins => plugins[`${name}@eigenwise-toolshed`] === true))
}
