import type { EngineInterface } from 'claude-code'

import { TRACK_USAGE, commandsTakenText, parseSwitchChoice, recordingStatusText } from './recording-switch'
import { clearFailureStatus, isRecording, ledgerFileOf, readProject, setRecording } from './session-ledger'

// The older version called this command `board`. A command is one bare name for the whole session, and the work
// board's plugin registers `/board`: the host refused whichever of the two came second, and that plugin's start stopped there.
export const USAGE_PAGE_COMMAND = 'usage-page'

// In the order of the registrations below, which stay written out so the docs' command list finds them.
const COMMAND_NAMES = ['track', USAGE_PAGE_COMMAND] as const

/** Registers each command by itself, so a name another plugin holds costs that one command and nothing else. */
export async function registerCommands($: EngineInterface): Promise<void> {
  const outcomes = await Promise.allSettled([
    $.command.register({ name: 'track', description: 'Record this project’s turns into the usage ledger', argumentHint: 'on|off|status', immediate: true }),
    $.command.register({ name: 'usage-page', description: 'Build the usage page from every recorded project and open it', immediate: true }),
  ])
  const taken = COMMAND_NAMES.filter((_, index) => outcomes[index]?.status === 'rejected')
  if (taken.length > 0) await $.ui.status(commandsTakenText(taken))
}

export async function trackCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const choice = parseSwitchChoice(args)
  if (choice === undefined) return { text: TRACK_USAGE }
  const project = await readProject($)
  if (choice !== 'status') await setRecording($, project, choice === 'on')
  if (choice === 'off') await clearFailureStatus($)
  return { text: recordingStatusText(await isRecording($, project), project.root, await ledgerFileOf($, project)) }
}
