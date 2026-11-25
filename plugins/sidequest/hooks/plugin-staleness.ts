// `recordKey` is the record's own key, `<plugin>@<marketplace>`: two marketplaces can each hold a plugin of one name.
export type InstalledEntry = { recordKey: string; scope: string; projectPath: string | undefined; installPath: string; version: string | undefined }

export type RunningPlugin = { name: string; version: string; root: string; recordKey: string; scope: string; projectPath: string | undefined }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const textOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const spelledWithSlashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const samePath = (left: string, right: string): boolean => spelledWithSlashes(left) === spelledWithSlashes(right)

function entryOf(recordKey: string, value: unknown): InstalledEntry | undefined {
  if (!isRecord(value)) return undefined
  const scope = textOrUndefined(value.scope)
  const installPath = textOrUndefined(value.installPath)

  return scope === undefined || installPath === undefined
    ? undefined
    : { recordKey, scope, projectPath: textOrUndefined(value.projectPath), installPath, version: textOrUndefined(value.version) }
}

function parsedJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)

    return parsed
  } catch {
    return undefined
  }
}

function entriesOfKey(recordKey: string, entries: unknown): InstalledEntry[] {
  return Array.isArray(entries) ? entries.flatMap(entry => entryOf(recordKey, entry) ?? []) : []
}

export function installedEntriesOf(recordText: string, pluginName: string): InstalledEntry[] {
  const record = parsedJson(recordText)
  if (!isRecord(record) || !isRecord(record.plugins)) return []
  const plugins = record.plugins

  return Object.keys(plugins)
    .filter(key => key.split('@')[0] === pluginName)
    .flatMap(key => entriesOfKey(key, plugins[key]))
}

export function versionOfManifest(manifestText: string): string | undefined {
  const manifest = parsedJson(manifestText)

  return isRecord(manifest) ? textOrUndefined(manifest.version) : undefined
}

export function runningPluginOf(name: string, root: string, manifestText: string, recordText: string): RunningPlugin | undefined {
  const version = versionOfManifest(manifestText)
  const ownEntry = installedEntriesOf(recordText, name).find(entry => samePath(entry.installPath, root))
  if (version === undefined || ownEntry === undefined) return undefined

  return { name, version, root, recordKey: ownEntry.recordKey, scope: ownEntry.scope, projectPath: ownEntry.projectPath }
}

// Seen in a project that moved from an older marketplace and kept its plugin of the same name installed: that entry,
// same scope and same folder, was read as this plugin's newer version at every turn end.
const isSameInstall = (running: RunningPlugin, entry: InstalledEntry): boolean =>
  entry.recordKey === running.recordKey && entry.scope === running.scope && entry.projectPath === running.projectPath

export function outdatedPluginLine(running: RunningPlugin, recordText: string): string | undefined {
  const installed = installedEntriesOf(recordText, running.name).find(entry => isSameInstall(running, entry))
  if (installed === undefined || installed.version === undefined || samePath(installed.installPath, running.root)) return undefined

  return `${running.name} ${installed.version} is installed, this session runs ${running.version}. Run /reload-plugins or restart to get it.`
}
