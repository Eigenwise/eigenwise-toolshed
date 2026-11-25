import type { EngineInterface } from 'claude-code'

import { olderOnlyPluginsOn } from './older-leftovers'
import {
  installedEntriesOf,
  installedTwiceLine,
  isRunningFromThePrivateMarketplace,
  moveMarketplaceLine,
  pluginsInstalledFromThePrivateMarketplace,
  quartermasterLines,
} from './older-toolshed'
import type { InstalledEntry, InstalledUnderBothNames, LeftoverKind } from './older-toolshed'
import {
  configDirectoryOfSession,
  installedTwiceIn,
  lookAtProject,
  readInstalledPluginsText,
  rememberInstalledTwiceTold,
  rememberMoveTold,
  showNotice,
  wasInstalledTwiceToldOnThisMachine,
  wasMoveToldOnThisMachine,
} from './older-toolshed-session'

const ALL_CONCERNS: readonly LeftoverKind[] = ['map', 'board', 'rules']

async function toolshedEntriesOf($: EngineInterface, configDirectory: string | undefined): Promise<InstalledEntry[]> {
  const recordText = await readInstalledPluginsText($, configDirectory)

  return recordText === undefined ? [] : installedEntriesOf(recordText)
}

async function installedTwiceLines($: EngineInterface, doubled: readonly InstalledUnderBothNames[]): Promise<string[]> {
  if (doubled.length === 0 || (await wasInstalledTwiceToldOnThisMachine($))) return []
  await rememberInstalledTwiceTold($)

  return [installedTwiceLine(doubled)]
}

async function moveLines($: EngineInterface, entries: readonly InstalledEntry[], doubled: readonly InstalledUnderBothNames[]): Promise<string[]> {
  if (await wasMoveToldOnThisMachine($)) return []
  const names = pluginsInstalledFromThePrivateMarketplace(entries).filter(name => !doubled.some(twice => twice.plugin === name))
  if (names.length === 0) return []
  await rememberMoveTold($)

  return [moveMarketplaceLine(names)]
}

// Only the first look at a project, or a Quartermaster that came from the private marketplace itself, reads the install record for this.
async function moveAndInstalledTwiceLines($: EngineInterface, configDirectory: string | undefined, projectFolder: string, isFirstLook: boolean): Promise<string[]> {
  if (!(isFirstLook || isRunningFromThePrivateMarketplace($.plugin.root))) return []
  const entries = await toolshedEntriesOf($, configDirectory)
  const doubled = await installedTwiceIn($, entries, projectFolder, configDirectory)

  return [...(await installedTwiceLines($, doubled)), ...(await moveLines($, entries, doubled))]
}

/** Quartermaster is the one voice for every plugin, so the others stay quiet when it is installed. */
export async function tellAboutOlderToolshedForAll($: EngineInterface, projectFolder: string): Promise<void> {
  const configDirectory = await configDirectoryOfSession($)
  const looked = await lookAtProject($, projectFolder, configDirectory, ALL_CONCERNS)
  const projectLines = looked === undefined ? [] : quartermasterLines(looked.leftovers, olderOnlyPluginsOn(looked.settings), looked.gateway)
  await showNotice($, [...projectLines, ...(await moveAndInstalledTwiceLines($, configDirectory, projectFolder, looked !== undefined))])
}
