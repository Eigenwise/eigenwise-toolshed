import type { EngineInterface } from 'claude-code'

import { configDirectoryOf } from './config-directory.mjs'
import {
  displayedPath,
  foldersLookedAt,
  hintForStanding,
  hasHooksModule,
  installedEntriesOf,
  isQuartermasterSwitchedOff,
  isRunningFromThePrivateMarketplace,
  moveMarketplaceLine,
  plainLines,
  projectKeyOf,
  quartermasterInstallsFor,
  spelledWithSlashes,
} from './older-toolshed'
import type { LeftoverFound, LeftoverKind, QuartermasterStanding } from './older-toolshed'
import { gatewayWiringIn } from './older-gateway'
import type { GatewayWiring, SettingsFile } from './older-gateway'

type Engine = EngineInterface

const LOOKED_FOLDERS_KEY = 'olderToolshedLookedInFolders'
const MOVE_TOLD_KEY = 'olderMarketplaceMoveTold'

export function readTextOrUndefined($: Engine, path: string): Promise<string | undefined> {
  return $.fs.read(path).then(
    text => text,
    () => undefined,
  )
}

export async function configDirectoryOfSession($: Engine): Promise<string | undefined> {
  const [CLAUDE_CONFIG_DIR, HOME, USERPROFILE] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')])

  return configDirectoryOf({ CLAUDE_CONFIG_DIR, HOME, USERPROFILE })
}

export async function readInstalledPluginsText($: Engine, configDirectory: string | undefined): Promise<string | undefined> {
  return configDirectory === undefined ? undefined : readTextOrUndefined($, `${configDirectory}/plugins/installed_plugins.json`)
}

async function olderMapFound($: Engine, projectFolder: string): Promise<LeftoverFound | undefined> {
  const where = '.claude/.codebase-info/'
  if (!(await $.fs.exists(`${projectFolder}/.claude/.codebase-info`))) return undefined
  const hasNewMap = await Promise.all([$.fs.exists(`${projectFolder}/.claude/rules/codebase-map.md`), $.fs.exists(`${projectFolder}/.claude/rules/map`)])

  return hasNewMap.includes(true) ? undefined : { kind: 'map', where }
}

async function olderBoardFound($: Engine, projectFolder: string, configDirectory: string | undefined): Promise<LeftoverFound | undefined> {
  if (configDirectory === undefined) return undefined
  const where = `${configDirectory}/sidequest/sidequest.db`
  if (!(await $.fs.exists(where)) || (await $.fs.exists(`${projectFolder}/.sidequest`))) return undefined

  return { kind: 'board', where }
}

async function olderRulesFound($: Engine, projectFolder: string): Promise<LeftoverFound | undefined> {
  for (const where of ['.claude/live-rules', '.claude/live-rules.md']) {
    if (await $.fs.exists(`${projectFolder}/${where}`)) return { kind: 'rules', where }
  }

  return undefined
}

function finderOf(kind: LeftoverKind, $: Engine, projectFolder: string, configDirectory: string | undefined): Promise<LeftoverFound | undefined> {
  if (kind === 'map') return olderMapFound($, projectFolder)

  return kind === 'board' ? olderBoardFound($, projectFolder, configDirectory) : olderRulesFound($, projectFolder)
}

export async function findLeftovers(
  $: Engine,
  projectFolder: string,
  configDirectory: string | undefined,
  concerns: readonly LeftoverKind[],
): Promise<LeftoverFound[]> {
  const found = await Promise.all(concerns.map(kind => finderOf(kind, $, projectFolder, configDirectory)))

  return found.flatMap(item => item ?? [])
}

export async function wasLookedAt($: Engine, projectFolder: string): Promise<boolean> {
  return foldersLookedAt(await $.store.get(LOOKED_FOLDERS_KEY)).includes(projectKeyOf(projectFolder))
}

async function rememberLookedAt($: Engine, projectFolder: string): Promise<void> {
  const looked = foldersLookedAt(await $.store.get(LOOKED_FOLDERS_KEY))
  await $.store.set(LOOKED_FOLDERS_KEY, [...looked, projectKeyOf(projectFolder)])
}

export async function wasMoveToldOnThisMachine($: Engine): Promise<boolean> {
  return (await $.store.get(MOVE_TOLD_KEY)) === true
}

export function rememberMoveTold($: Engine): Promise<void> {
  return $.store.set(MOVE_TOLD_KEY, true)
}

export async function readLabeledSettings($: Engine, projectFolder: string, configDirectory: string | undefined): Promise<SettingsFile[]> {
  const places = [
    { label: '.claude/settings.local.json', path: `${projectFolder}/.claude/settings.local.json`, isUserWide: false },
    { label: '.claude/settings.json', path: `${projectFolder}/.claude/settings.json`, isUserWide: false },
    ...(configDirectory === undefined ? [] : [{ label: displayedPath(`${configDirectory}/settings.json`), path: `${configDirectory}/settings.json`, isUserWide: true }]),
  ]
  const texts = await Promise.all(places.map(place => readTextOrUndefined($, place.path)))

  return places.flatMap((place, index) => {
    const text = texts[index]

    return text === undefined ? [] : [{ label: place.label, text, isUserWide: place.isUserWide }]
  })
}

async function installHasModule($: Engine, installPath: string): Promise<boolean> {
  const hooksText = await readTextOrUndefined($, `${spelledWithSlashes(installPath)}/hooks/hooks.json`)

  return hooksText !== undefined && hasHooksModule(hooksText)
}

/** Plugins cannot see each other's state in time at session start, so the files decide: an installed, switched-on Quartermaster with a module speaks for all. */
export async function quartermasterStandingFor($: Engine, projectFolder: string, configDirectory: string | undefined): Promise<QuartermasterStanding> {
  const recordText = await readInstalledPluginsText($, configDirectory)
  const installs = recordText === undefined ? [] : quartermasterInstallsFor(installedEntriesOf(recordText), projectFolder)
  const hasModuleInstall = (await Promise.all(installs.map(install => installHasModule($, install.installPath)))).includes(true)
  if (!hasModuleInstall) return 'absent'
  const settings = await readLabeledSettings($, projectFolder, configDirectory)

  return isQuartermasterSwitchedOff(settings.map(file => file.text)) ? 'switched-off' : 'speaks'
}

export async function showNotice($: Engine, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return
  const text = lines.join('\n')
  $.ui.toast(text)
  await $.ui.notify(text, { key: 'older-toolshed' })
}

export type Looked = { leftovers: LeftoverFound[]; gateway: GatewayWiring | undefined; settings: SettingsFile[] }

/** The one look at a project: what it holds of the older Toolshed. Remembered, found or not, so a later start reads only the store. */
export async function lookAtProject($: Engine, projectFolder: string, configDirectory: string | undefined, concerns: readonly LeftoverKind[]): Promise<Looked | undefined> {
  if (await wasLookedAt($, projectFolder)) return undefined
  const [leftovers, settings] = await Promise.all([findLeftovers($, projectFolder, configDirectory, concerns), readLabeledSettings($, projectFolder, configDirectory)])
  await rememberLookedAt($, projectFolder)

  return { leftovers, gateway: gatewayWiringIn(settings), settings }
}

async function projectLinesOf($: Engine, projectFolder: string, configDirectory: string | undefined, concern: LeftoverKind): Promise<string[]> {
  const looked = await lookAtProject($, projectFolder, configDirectory, [concern])
  if (looked === undefined || (looked.leftovers.length === 0 && looked.gateway === undefined)) return []
  const standing = await quartermasterStandingFor($, projectFolder, configDirectory)

  return standing === 'speaks' ? [] : plainLines(looked.leftovers, looked.gateway, hintForStanding(standing))
}

async function moveLinesOf($: Engine, projectFolder: string, configDirectory: string | undefined): Promise<string[]> {
  if (!isRunningFromThePrivateMarketplace($.plugin.root) || (await wasMoveToldOnThisMachine($))) return []
  if ((await quartermasterStandingFor($, projectFolder, configDirectory)) === 'speaks') return []
  await rememberMoveTold($)

  return [moveMarketplaceLine([$.plugin.name])]
}

/**
 * One plugin's own leftover and the gateway wiring are looked for once per project, and the move off the private
 * marketplace is said once per machine. Quartermaster says all of it for the others when it is installed.
 */
export async function tellAboutOlderToolshed($: Engine, projectFolder: string, concern: LeftoverKind): Promise<void> {
  const configDirectory = await configDirectoryOfSession($)
  const lines = await projectLinesOf($, projectFolder, configDirectory, concern)
  const moveLines = await moveLinesOf($, projectFolder, configDirectory)
  await showNotice($, [...lines, ...moveLines])
}
