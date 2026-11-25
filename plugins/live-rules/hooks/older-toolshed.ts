import type { GatewayWiring } from './older-gateway'

export type LeftoverKind = 'map' | 'board' | 'rules'

export type LeftoverFound = { kind: LeftoverKind; where: string }

export type InstalledEntry = {
  plugin: string
  marketplace: string
  scope: string
  projectPath: string | undefined
  installPath: string
}

export const MARKETPLACE_AFTER_THE_SWITCH = 'eigenwise-toolshed'
export const MARKETPLACE_BEFORE_THE_SWITCH = 'toolshed-next'
export const TOOLSHED_PLUGIN_NAMES = ['sidequest', 'quartermaster', 'codebase-mapper', 'live-rules', 'observability'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const textOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const spelledWithSlashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

function parsedJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)

    return parsed
  } catch {
    return undefined
  }
}

function entryFrom(plugin: string, marketplace: string, install: Record<string, unknown>): InstalledEntry | undefined {
  const scope = textOrUndefined(install.scope)
  const installPath = textOrUndefined(install.installPath)

  return scope === undefined || installPath === undefined
    ? undefined
    : { plugin, marketplace, scope, projectPath: textOrUndefined(install.projectPath), installPath }
}

function entryOf(recordKey: string, value: unknown): InstalledEntry | undefined {
  const [plugin, marketplace] = recordKey.split('@')
  if (!isRecord(value) || plugin === undefined || marketplace === undefined) return undefined

  return entryFrom(plugin, marketplace, value)
}

export function installedEntriesOf(recordText: string): InstalledEntry[] {
  const record = parsedJson(recordText)
  if (!isRecord(record) || !isRecord(record.plugins)) return []
  const plugins = record.plugins

  return Object.keys(plugins).flatMap(recordKey => {
    const installs = plugins[recordKey]

    return Array.isArray(installs) ? installs.flatMap(install => entryOf(recordKey, install) ?? []) : []
  })
}

const MARKETPLACE_IN_INSTALL_PATH = /\/plugins\/(?:cache|marketplaces)\/([^/]+)\//

export function marketplaceOfInstallPath(installPath: string): string | undefined {
  return MARKETPLACE_IN_INSTALL_PATH.exec(spelledWithSlashes(installPath))?.[1]
}

export const isRunningFromThePrivateMarketplace = (root: string): boolean => marketplaceOfInstallPath(root) === MARKETPLACE_BEFORE_THE_SWITCH

function isInsideProject(entry: InstalledEntry, projectFolder: string): boolean {
  if (entry.scope === 'user') return true
  if (entry.projectPath === undefined) return false
  const root = spelledWithSlashes(entry.projectPath).toLowerCase()
  const folder = spelledWithSlashes(projectFolder).toLowerCase()

  return folder === root || folder.startsWith(`${root}/`)
}

export const quartermasterInstallsFor = (entries: readonly InstalledEntry[], projectFolder: string): InstalledEntry[] =>
  entries.filter(entry => entry.plugin === 'quartermaster' && isInsideProject(entry, projectFolder))

// The older Quartermaster ran command hooks and has no module, so only a module install can say the notice.
export function hasHooksModule(hooksFileText: string): boolean {
  const hooks = parsedJson(hooksFileText)

  return isRecord(hooks) && Array.isArray(hooks.modules) && hooks.modules.length > 0
}

export function isQuartermasterSwitchedOff(settingsTexts: readonly string[]): boolean {
  return settingsTexts.some(text => {
    const settings = parsedJson(text)
    const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}

    return Object.keys(enabled).some(key => key.startsWith('quartermaster@') && enabled[key] === false)
  })
}

export function pluginsInstalledFromThePrivateMarketplace(entries: readonly InstalledEntry[]): string[] {
  const names = entries
    .filter(entry => entry.marketplace === MARKETPLACE_BEFORE_THE_SWITCH && TOOLSHED_PLUGIN_NAMES.some(name => name === entry.plugin))
    .map(entry => entry.plugin)

  return [...new Set(names)]
}

const listedInWords = (items: readonly string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export type QuartermasterHint = 'none' | 'install' | 'switch-on'

export type QuartermasterStanding = 'speaks' | 'switched-off' | 'absent'

const HINT_TEXT: Record<QuartermasterHint, string> = {
  none: '',
  install: ' (install it first: claude plugin install quartermaster@eigenwise-toolshed)',
  'switch-on': ' (switch Quartermaster back on for this project first)',
}

const HINT_FOR_STANDING: Record<QuartermasterStanding, QuartermasterHint> = { speaks: 'none', 'switched-off': 'switch-on', absent: 'install' }

export const hintForStanding = (standing: QuartermasterStanding): QuartermasterHint => HINT_FOR_STANDING[standing]

const withHint = (sentence: string, hint: QuartermasterHint): string => `${sentence.slice(0, -1)}${HINT_TEXT[hint]}.`

// One path, in the separator the platform's own config folder uses.
export const displayedPath = (path: string): string => (path.includes('\\') ? path.replace(/\//g, '\\') : path)

const LEFTOVER_LINES: Record<LeftoverKind, (found: LeftoverFound, hint: QuartermasterHint) => string> = {
  map: found => `The older map in ${found.where} is not used. /codebase-mapper:map builds a new one from it.`,
  board: (_, hint) =>
    withHint("The older board's tickets are not on this board. /quartermaster:upgrade offers to redraft the ones you pick.", hint),
  rules: (found, hint) => withHint(`The older rules in ${found.where} no longer apply. /quartermaster:upgrade converts them.`, hint),
}

export function gatewayLine(wiring: GatewayWiring, hint: QuartermasterHint): string {
  const whoIsWired = wiring.isUserWide ? 'Every project on this machine is' : 'This project is'
  const whoCannotReach = wiring.isUserWide ? 'a session in any project' : 'a session here'
  const warning = `Uninstalling model-gateway before the wiring is gone would block every prompt${wiring.isUserWide ? ' in every project' : ' here'}.`
  const unwires = withHint('/quartermaster:upgrade unwires it.', hint)

  // The upgrade first: once the address is deleted by hand it can no longer tell which other keys the gateway wrote.
  return `${whoIsWired} still wired to the older model gateway in ${wiring.file}. ${unwires} If ${whoCannotReach} cannot reach a model, delete the ANTHROPIC_BASE_URL line under env in that file by hand first. ${warning}`
}

const gatewayLines = (gateway: GatewayWiring | undefined, hint: QuartermasterHint): string[] => (gateway === undefined ? [] : [gatewayLine(gateway, hint)])

/** What Codebase Mapper, Sidequest and Live Rules say: the gateway first, then their own leftover. */
export const plainLines = (leftovers: readonly LeftoverFound[], gateway: GatewayWiring | undefined, hint: QuartermasterHint): string[] => [
  ...gatewayLines(gateway, hint),
  ...leftovers.map(found => LEFTOVER_LINES[found.kind](found, hint)),
]

type OlderThing = { text: string; isPlural: boolean }

const OLDER_THINGS: Record<LeftoverKind, OlderThing> = {
  map: { text: 'the older map in this project', isPlural: false },
  board: { text: 'the older board in your home folder', isPlural: false },
  rules: { text: 'the older rules in this project', isPlural: true },
}

const pronounFor = (things: readonly OlderThing[]): string => (things.length === 1 && things[0]?.isPlural === false ? 'it' : 'them')

const olderPluginsSentence = (olderPlugins: readonly string[]): string =>
  olderPlugins.length === 1
    ? `The older plugin ${olderPlugins.join('')} is still switched on.`
    : `The older plugins ${listedInWords(olderPlugins)} are still switched on.`

function leftoversSentence(things: readonly OlderThing[]): string {
  return `The older Toolshed left ${listedInWords(things.map(thing => thing.text))}, and nothing uses ${pronounFor(things)} now.`
}

const pluginsThing = (plugins: readonly string[]): OlderThing[] => (plugins.length > 0 ? [{ text: 'plugins', isPlural: plugins.length > 1 }] : [])

function whatIsLeftSentences(things: readonly OlderThing[], plugins: readonly string[]): string[] {
  return [...(things.length > 0 ? [leftoversSentence(things)] : []), ...(plugins.length > 0 ? [olderPluginsSentence(plugins)] : [])]
}

/**
 * Quartermaster's notice: the gateway first, since it can stop a session reaching a model, then the leftovers and the
 * older plugins still switched on, each in its own sentence. The gateway line covers the gateway plugin.
 */
export function quartermasterLines(leftovers: readonly LeftoverFound[], olderPlugins: readonly string[], gateway: GatewayWiring | undefined): string[] {
  const plugins = gateway === undefined ? olderPlugins : olderPlugins.filter(name => name !== 'model-gateway')
  const things = leftovers.map(found => OLDER_THINGS[found.kind])
  const sentences = whatIsLeftSentences(things, plugins)
  if (sentences.length === 0) return gatewayLines(gateway, 'none')
  const pronoun = pronounFor([...things, ...pluginsThing(plugins)])

  return [...gatewayLines(gateway, 'none'), `${sentences.join(' ')} /quartermaster:upgrade moves ${pronoun}.`]
}

export function moveMarketplaceLine(pluginNames: readonly string[]): string {
  const commands = [
    ...pluginNames.map(name => `claude plugin uninstall ${name}@${MARKETPLACE_BEFORE_THE_SWITCH}`),
    `claude plugin marketplace remove ${MARKETPLACE_BEFORE_THE_SWITCH}`,
    'claude plugin marketplace add Eigenwise/eigenwise-toolshed',
    ...pluginNames.map(name => `claude plugin install ${name}@${MARKETPLACE_AFTER_THE_SWITCH}`),
  ]

  return `${listedInWords(pluginNames)} came from ${MARKETPLACE_BEFORE_THE_SWITCH}, a name that is gone. To move to ${MARKETPLACE_AFTER_THE_SWITCH}, run: ${commands.join('; ')}.`
}

export const projectKeyOf = (projectFolder: string): string => spelledWithSlashes(projectFolder)

export const foldersLookedAt = (stored: unknown): string[] =>
  Array.isArray(stored) ? stored.filter((folder): folder is string => typeof folder === 'string') : []
