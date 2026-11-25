export type SwitchChoice = 'on' | 'off' | 'status'

export const TRACK_USAGE = 'Usage: /track on|off|status'

const CHOICES = new Map<string, SwitchChoice>([
  ['on', 'on'],
  ['off', 'off'],
  ['status', 'status'],
  ['', 'status'],
])

export const parseSwitchChoice = (args: string): SwitchChoice | undefined => CHOICES.get(args.trim().toLowerCase())

// The older plugin's key, so a project it recorded keeps recording after the update.
export const switchKeyOf = (projectRoot: string): string => `track:${projectRoot}`

const NO_LEDGER_PLACE = 'nowhere (no config or home folder found)'

export const recordingStatusText = (isRecording: boolean, projectRoot: string, ledgerFile: string | undefined): string =>
  isRecording
    ? `observability: recording turns for ${projectRoot}, into ${ledgerFile ?? NO_LEDGER_PLACE}`
    : `observability: not recording turns for ${projectRoot}. Switched on with /track on, it records into ${ledgerFile ?? NO_LEDGER_PLACE}`

export const commandsTakenText = (names: readonly string[]): string =>
  names.length === 1
    ? `observability: /${names[0]} already belongs to another plugin here, so observability's does not run`
    : `observability: ${names.map(name => `/${name}`).join(' and ')} already belong to another plugin here, so observability's do not run`

export const boardWrittenText = (file: string, isAtThisScreen: boolean): string =>
  isAtThisScreen ? `observability: usage page written to ${file}` : `observability: usage page written to ${file} on this computer; open it there.`
