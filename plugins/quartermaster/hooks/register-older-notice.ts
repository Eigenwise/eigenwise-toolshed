import type { EngineInterface } from 'claude-code'

import { olderOnlyPluginsOn } from './older-leftovers'
import {
  installedEntriesOf,
  isRunningFromThePrivateMarketplace,
  moveMarketplaceLine,
  pluginsInstalledFromThePrivateMarketplace,
  quartermasterLines,
} from './older-toolshed'
import type { LeftoverKind } from './older-toolshed'
import {
  configDirectoryOfSession,
  lookAtProject,
  readInstalledPluginsText,
  rememberMoveTold,
  showNotice,
  wasMoveToldOnThisMachine,
} from './older-toolshed-session'

const ALL_CONCERNS: readonly LeftoverKind[] = ['map', 'board', 'rules']

async function pluginsOnThePrivateMarketplace($: EngineInterface, configDirectory: string | undefined): Promise<string[]> {
  const recordText = await readInstalledPluginsText($, configDirectory)

  return recordText === undefined ? [] : pluginsInstalledFromThePrivateMarketplace(installedEntriesOf(recordText))
}

// Only the first look at a project, or a Quartermaster that came from the private marketplace itself, reads the install record for this.
async function moveLines($: EngineInterface, configDirectory: string | undefined, isFirstLook: boolean): Promise<string[]> {
  if (!(isFirstLook || isRunningFromThePrivateMarketplace($.plugin.root))) return []
  if (await wasMoveToldOnThisMachine($)) return []
  const names = await pluginsOnThePrivateMarketplace($, configDirectory)
  if (names.length === 0) return []
  await rememberMoveTold($)

  return [moveMarketplaceLine(names)]
}

/** Quartermaster is the one voice for every plugin, so the others stay quiet when it is installed. */
export async function tellAboutOlderToolshedForAll($: EngineInterface, projectFolder: string): Promise<void> {
  const configDirectory = await configDirectoryOfSession($)
  const looked = await lookAtProject($, projectFolder, configDirectory, ALL_CONCERNS)
  const projectLines = looked === undefined ? [] : quartermasterLines(looked.leftovers, olderOnlyPluginsOn(looked.settings), looked.gateway)
  await showNotice($, [...projectLines, ...(await moveLines($, configDirectory, looked !== undefined))])
}
