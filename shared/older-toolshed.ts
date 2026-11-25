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

export type EarlierNameCopy = { scope: string; projectPath: string | undefined }

export type InstalledUnderBothNames = {
  plugin: string
  earlierNameCopies: EarlierNameCopy[]
  /** The copy from the shared name is switched off here, so removing the earlier-name copy would leave the plugin off. */
  isOnlyEarlierNameCopySwitchedOn: boolean
  /** The user settings switch on the earlier-name copy at user scope and no shared-name copy there, so removing it takes the plugin from every other project. */
  isOnlyEarlierNameCopyOnInOtherProjects: boolean
  /** The user settings switch on the earlier-name copy at user scope, so a project that switched the shared-name copy off itself runs the plugin from it. */
  isEarlierNameCopyOnInOtherProjects: boolean
}

const isToolshedPlugin = (name: string): boolean => TOOLSHED_PLUGIN_NAMES.some(known => known === name)

const enabledPluginsOf = (settingsText: string): Record<string, unknown> => {
  const settings = parsedJson(settingsText)

  return isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
}

/**
 * Settings texts come in the order the host reads them: local, then committed, then user. The first file that names
 * the key decides. A copy no file names is off, as the host lists it: an install writes its own key.
 */
function isSwitchedOn(copy: InstalledEntry, settingsTexts: readonly string[]): boolean {
  const key = `${copy.plugin}@${copy.marketplace}`
  const value = settingsTexts.map(text => enabledPluginsOf(text)[key]).find(candidate => typeof candidate === 'boolean')

  return value === true
}

// Another project sees a copy at user scope, switched by the user settings, and whatever its own files say, which this project cannot read.
const isOnInOtherProjects = (copy: InstalledEntry, userSettingsText: string): boolean => copy.scope === 'user' && isSwitchedOn(copy, [userSettingsText])

const holdsOnlyForTheEarlierName = (earlierNameCopies: readonly InstalledEntry[], sharedNameCopies: readonly InstalledEntry[], holds: (copy: InstalledEntry) => boolean): boolean =>
  earlierNameCopies.some(holds) && !sharedNameCopies.some(holds)

const isEarlierNameCopy = (entry: InstalledEntry): boolean => entry.marketplace === MARKETPLACE_BEFORE_THE_SWITCH

const isSharedNameCopy = (entry: InstalledEntry): boolean => entry.marketplace === MARKETPLACE_AFTER_THE_SWITCH

const withoutRepeatedPlaces = (copies: readonly EarlierNameCopy[]): EarlierNameCopy[] =>
  copies.filter((copy, index) => copies.findIndex(other => other.scope === copy.scope && other.projectPath === copy.projectPath) === index)

function doubledFrom(plugin: string, copies: readonly InstalledEntry[], settingsTexts: readonly string[], userSettingsText: string): InstalledUnderBothNames[] {
  const earlierNameCopies = copies.filter(isEarlierNameCopy)
  const sharedNameCopies = copies.filter(isSharedNameCopy)
  if (earlierNameCopies.length === 0 || sharedNameCopies.length === 0) return []
  const places = earlierNameCopies.map(copy => ({ scope: copy.scope, projectPath: copy.projectPath }))

  return [
    {
      plugin,
      earlierNameCopies: withoutRepeatedPlaces(places),
      isOnlyEarlierNameCopySwitchedOn: holdsOnlyForTheEarlierName(earlierNameCopies, sharedNameCopies, copy => isSwitchedOn(copy, settingsTexts)),
      isOnlyEarlierNameCopyOnInOtherProjects: holdsOnlyForTheEarlierName(earlierNameCopies, sharedNameCopies, copy => isOnInOtherProjects(copy, userSettingsText)),
      isEarlierNameCopyOnInOtherProjects: earlierNameCopies.some(copy => isOnInOtherProjects(copy, userSettingsText)),
    },
  ]
}

/**
 * The plugins installed from both marketplace names where this project can see both copies. The user settings text is
 * also given on its own, because it alone says what the person's other projects run.
 */
export function installedUnderBothNames(
  entries: readonly InstalledEntry[],
  projectFolder: string,
  settingsTexts: readonly string[],
  userSettingsText = '',
): InstalledUnderBothNames[] {
  const visible = entries.filter(entry => isToolshedPlugin(entry.plugin) && isInsideProject(entry, projectFolder))
  const names = [...new Set(visible.map(entry => entry.plugin))]

  return names.flatMap(plugin =>
    doubledFrom(
      plugin,
      visible.filter(entry => entry.plugin === plugin),
      settingsTexts,
      userSettingsText,
    ),
  )
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

const uninstallCommandsFor = (doubled: InstalledUnderBothNames): string[] =>
  doubled.earlierNameCopies.map(
    copy => `claude plugin uninstall ${doubled.plugin}@${MARKETPLACE_BEFORE_THE_SWITCH}${copy.scope === 'user' ? '' : ` --scope ${copy.scope}`}`,
  )

const foldersOfProjectCommands = (doubledPlugins: readonly InstalledUnderBothNames[]): string[] => {
  const folders = doubledPlugins.flatMap(doubled => doubled.earlierNameCopies.filter(copy => copy.scope !== 'user').map(copy => copy.projectPath ?? 'the project folder'))

  return [...new Set(folders)]
}

// A command at project or local scope only finds its copy from inside that project.
const fromTheProjectFolder = (doubledPlugins: readonly InstalledUnderBothNames[]): string => {
  const folders = foldersOfProjectCommands(doubledPlugins)

  return folders.length === 0 ? '' : ` Run the ones with --scope from ${listedInWords(folders)}.`
}

const commandsToRemove = (doubledPlugins: readonly InstalledUnderBothNames[]): string =>
  `${doubledPlugins.flatMap(uninstallCommandsFor).join('; ')}.${fromTheProjectFolder(doubledPlugins)}`

const verbFor = (items: readonly unknown[]): string => (items.length === 1 ? 'is' : 'are')

const namesOf = (doubledPlugins: readonly InstalledUnderBothNames[]): string => listedInWords(doubledPlugins.map(doubled => doubled.plugin))

function bothCopiesAreOnSentence(doubledPlugins: readonly InstalledUnderBothNames[]): string {
  return `${namesOf(doubledPlugins)} ${verbFor(doubledPlugins)} also installed from ${MARKETPLACE_BEFORE_THE_SWITCH}. Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. To remove the ${MARKETPLACE_BEFORE_THE_SWITCH} copy, run: ${commandsToRemove(doubledPlugins)}`
}

const commandsToSwitchOn = (doubledPlugins: readonly InstalledUnderBothNames[]): string =>
  doubledPlugins.map(doubled => `claude plugin enable ${doubled.plugin}@${MARKETPLACE_AFTER_THE_SWITCH} --scope local`).join('; ')

function onlyEarlierNameIsOnSentence(doubledPlugins: readonly InstalledUnderBothNames[]): string {
  return `${namesOf(doubledPlugins)} ${verbFor(doubledPlugins)} installed from ${MARKETPLACE_BEFORE_THE_SWITCH} and from ${MARKETPLACE_AFTER_THE_SWITCH}, and here only the ${MARKETPLACE_BEFORE_THE_SWITCH} copy is switched on. Switch the ${MARKETPLACE_AFTER_THE_SWITCH} copy on for this project first, from the project folder: ${commandsToSwitchOn(doubledPlugins)}. Then remove the ${MARKETPLACE_BEFORE_THE_SWITCH} copy: ${commandsToRemove(doubledPlugins)}`
}

// Removing the copy the user settings switch on takes the plugin from every project that has no copy of its own.
function keepItInOtherProjectsSentence(doubledPlugins: readonly InstalledUnderBothNames[]): string[] {
  const plugins = doubledPlugins.filter(doubled => doubled.isOnlyEarlierNameCopyOnInOtherProjects)
  if (plugins.length === 0) return []
  const commands = plugins.map(doubled => `claude plugin install ${doubled.plugin}@${MARKETPLACE_AFTER_THE_SWITCH}`).join('; ')

  return [`Your other projects get ${namesOf(plugins)} from the ${MARKETPLACE_BEFORE_THE_SWITCH} copy. To keep ${plugins.length === 1 ? 'it' : 'them'} there, also run: ${commands}.`]
}

// Seen on a host: a second project had switched the shared-name copy off in its own settings and ran the plugin from
// the earlier-name copy at user scope. Following the line from the first project left it with the plugin off and
// no word. This project cannot read another project's settings, so the line can only say what to do there.
function switchedOffInAnotherProjectSentence(doubledPlugins: readonly InstalledUnderBothNames[]): string[] {
  const plugins = doubledPlugins.filter(doubled => doubled.isEarlierNameCopyOnInOtherProjects)
  if (plugins.length === 0) return []
  const commands = plugins.map(doubled => `claude plugin enable ${doubled.plugin}@${MARKETPLACE_AFTER_THE_SWITCH} --scope local`).join('; ')

  return [`A project where you switched the ${MARKETPLACE_AFTER_THE_SWITCH} copy off itself stops running ${namesOf(plugins)} with this. Switch it on there, from that project's folder: ${commands}.`]
}

const sentencesOf = (doubledPlugins: readonly InstalledUnderBothNames[], sentenceFor: (group: readonly InstalledUnderBothNames[]) => string): string[] =>
  doubledPlugins.length === 0 ? [] : [sentenceFor(doubledPlugins)]

/** Said by whichever copy runs, or by Quartermaster for the others: the commands remove the copies under the earlier name. */
export function installedTwiceLine(doubledPlugins: readonly InstalledUnderBothNames[]): string {
  const onlyEarlierNameIsOn = doubledPlugins.filter(doubled => doubled.isOnlyEarlierNameCopySwitchedOn)
  const bothAreOn = doubledPlugins.filter(doubled => !doubled.isOnlyEarlierNameCopySwitchedOn)

  return [
    ...sentencesOf(bothAreOn, bothCopiesAreOnSentence),
    ...sentencesOf(onlyEarlierNameIsOn, onlyEarlierNameIsOnSentence),
    ...keepItInOtherProjectsSentence(doubledPlugins),
    ...switchedOffInAnotherProjectSentence(doubledPlugins),
  ].join(' ')
}

export type CopyNotice = 'installed-twice' | 'move' | 'none'

export type CopyNoticeFacts = {
  isInstalledTwice: boolean
  isRunningFromThePrivateMarketplace: boolean
  wasInstalledTwiceTold: boolean
  wasMoveTold: boolean
}

/** A plugin installed from both names has nothing to move: it is told once that two copies are there, never to install the one it has. */
export function copyNoticeFor(facts: CopyNoticeFacts): CopyNotice {
  if (facts.isInstalledTwice) return facts.wasInstalledTwiceTold ? 'none' : 'installed-twice'

  return facts.isRunningFromThePrivateMarketplace && !facts.wasMoveTold ? 'move' : 'none'
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
