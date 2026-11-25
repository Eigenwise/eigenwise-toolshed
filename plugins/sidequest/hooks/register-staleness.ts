import type { EngineInterface } from 'claude-code'

import { outdatedPluginLine, runningPluginOf } from './plugin-staleness'
import type { RunningPlugin } from './plugin-staleness'
import { readInstalledPluginsRecord, readOptionalText } from './store'

// Kept in the module: a reload starts a fresh module, which is the point where the person is told again.
let runningPlugin: RunningPlugin | undefined
let isTold = false

export async function rememberRunningPlugin($: EngineInterface): Promise<void> {
  runningPlugin = undefined
  isTold = false
  const [manifestText, recordText] = await Promise.all([
    readOptionalText($, `${$.plugin.root}/.claude-plugin/plugin.json`),
    readInstalledPluginsRecord($),
  ])
  if (manifestText === undefined || recordText === undefined) return
  runningPlugin = runningPluginOf($.plugin.name, $.plugin.root, manifestText, recordText)
}

export async function warnWhenOutdated($: EngineInterface): Promise<void> {
  if (runningPlugin === undefined || isTold) return
  const recordText = await readInstalledPluginsRecord($)
  const line = recordText === undefined ? undefined : outdatedPluginLine(runningPlugin, recordText)
  if (line === undefined) return
  isTold = true
  $.ui.toast(line)
  await $.ui.notify(line, { title: 'Sidequest', key: 'outdated-plugin' })
}
