import type { SessionWork } from '../types'
import { textOf } from './tool-input'
import type { JsonRecord } from './tool-input'

// What the session is doing right now, in a person's words. The row once said only that the session was busy and how
// many steps it had taken, and a person watched it sit unchanged and asked what it meant.

export const THINKING = 'thinking'

const LONGEST_ACTIVITY = 48
const CONNECTOR_TOOL = /^mcp__(.+?)__(.+)$/

const FILE_VERBS: Record<string, string> = { Read: 'reading', Edit: 'editing', Write: 'writing', NotebookEdit: 'editing' }

const WORDS_FOR_A_TOOL: Record<string, string> = {
  Grep: 'searching the code',
  Glob: 'searching the code',
  WebFetch: 'reading a web page',
  WebSearch: 'searching the web',
  ToolSearch: 'looking up a tool',
}

const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

const cutToFit = (text: string): string => (text.length <= LONGEST_ACTIVITY ? text : `${text.slice(0, LONGEST_ACTIVITY - 3)}...`)

const withSmallFirstLetter = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

const onAFile = (tool: string, input: JsonRecord): string | undefined => {
  const verb = FILE_VERBS[tool]
  const path = textOf(input, 'file_path') ?? textOf(input, 'notebook_path')

  return verb === undefined || path === undefined ? undefined : `${verb} ${baseName(path)}`
}

const loadingASkill = (tool: string, input: JsonRecord): string | undefined => {
  const skill = textOf(input, 'skill')

  return tool === 'Skill' && skill !== undefined ? `loading the ${skill} skill` : undefined
}

// A shell command, a script and an agent each come with the model's own line on what the call is for.
const inTheCallsOwnWords = (input: JsonRecord): string | undefined => {
  const description = textOf(input, 'description')?.trim() ?? ''

  return description === '' ? undefined : withSmallFirstLetter(description)
}

const inPlainWords = (name: string): string => name.replace(/[_-]+/g, ' ')

const onAConnector = (tool: string): string | undefined => {
  const parts = CONNECTOR_TOOL.exec(tool)

  return parts === null ? undefined : `${inPlainWords(parts[1] ?? '')}: ${inPlainWords(parts[2] ?? '')}`
}

const byKindOfTool = (tool: string, input: JsonRecord): string | undefined =>
  onAFile(tool, input) ?? loadingASkill(tool, input) ?? WORDS_FOR_A_TOOL[tool]

const byTheCallItself = (tool: string, input: JsonRecord): string => inTheCallsOwnWords(input) ?? onAConnector(tool) ?? 'working'

/** Never a raw tool name: a person reads this beside "This session". */
export const activityOf = (tool: string, input: JsonRecord): string => cutToFit(byKindOfTool(tool, input) ?? byTheCallItself(tool, input))

const twoDigits = (value: number): string => String(value).padStart(2, '0')

export const clockTime = (milliseconds: number): string => {
  const moment = new Date(milliseconds)

  return `${twoDigits(moment.getHours())}:${twoDigits(moment.getMinutes())}`
}

// The pane is redrawn when something changes, not on a clock, so a duration would freeze during one long call. The
// time it started cannot go stale, and against the clock it says whether the session is stuck.
export const sessionAside = (work: SessionWork): string => {
  const activity = work.activity ?? THINKING

  return work.since === undefined ? activity : `${activity}, since ${clockTime(work.since)}`
}
