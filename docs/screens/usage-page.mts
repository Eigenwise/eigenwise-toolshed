// Observability's usage page for the made-up project: three days of thumbnail work, then the PAY-41 session, one row
// per turn of the story. The turns are folded into ledger rows by the plugin's own recording functions, carried from
// turn to turn as its hook carries them, written to a scratch config folder's ledger, read back by its own reader and
// turned into the page by its own page code. The page is a real HTML file, so its picture is the browser's. Only the
// token counts, latencies and costs are made up.
import { readdirSync, readFileSync } from 'node:fs'

import {
  addAgentSpawn,
  addStep,
  addSubagentUsage,
  addTokens,
  addToolCall,
  appendLine,
  carryOverIntoNextTurn,
  foldTurn,
  freshRecording,
  NO_TOKENS,
  notePrompt,
  projectSlug,
} from '../../plugins/observability/hooks/ledger.ts'
import type { TurnEnd, TurnRow } from '../../plugins/observability/hooks/ledger.ts'
import { isLedgerFileName, ledgerFolderOf, rowsSince, sessionLedgerFile } from '../../plugins/observability/hooks/ledger-files.ts'
import type { Recording, RoutedRun, Tokens } from '../../plugins/observability/types/index.d.ts'
import { boardHtml } from '../../plugins/observability/scripts/board-page.mjs'

import * as madeUp from './made-up.mts'
import type { AgentReturn, PlayedStory, StoryTurn } from './sidequest-story.mts'
import { writeText } from './scratch-project.mts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const PAGE_DAYS = 90
const PAY_41_SESSION = 'session-pay-41'
const WORKDAY = 8 * HOUR

// A fixed sequence, so every run writes the same made-up numbers. The generator's low bits repeat every few steps,
// so a pick takes its high bits.
const numbersFrom = (seed: number) => {
  let state = seed

  return (below: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return Math.floor(state / 65536) % below
  }
}

type Pick = (below: number) => number

const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write']

const requestTokens = (pick: Pick): Tokens => ({ input: 200 + pick(800), output: 300 + pick(2000), cacheRead: 20_000 + pick(90_000), cacheWrite: pick(4000) })

type Requested = { recording: Recording; usage: Tokens }

// The host reports a turn's usage as the sum of its requests, so the turn's tokens and its models' tokens agree.
function withRequests(recording: Recording, model: string, count: number, pick: Pick): Requested {
  let requested: Requested = { recording, usage: NO_TOKENS }
  for (let request = 0; request < count; request += 1) {
    const usage = requestTokens(pick)
    requested = { recording: addStep(requested.recording, { model, latencyMs: 800 + pick(6000), usage }), usage: addTokens(requested.usage, usage) }
  }
  return requested
}

const withToolCalls = (recording: Recording, pick: Pick): Recording => {
  let called = recording
  for (let call = 0; call < 3 + pick(9); call += 1) called = addToolCall(called, { tool: TOOLS[pick(TOOLS.length)] ?? 'Read', durationMs: 40 + pick(3000), isError: false, isDenied: false })
  return called
}

// The permission path's block reaches the plugin's tool hook as an error result, so it counts as an error. The plugin
// counts a denial only when a plugin's own hook refused the call.
const withBlockedRun = (recording: Recording): Recording => addToolCall(recording, { tool: 'Bash', durationMs: 30, isError: true, isDenied: false })

// An agent's requests and tool calls go into the session's one recording, and its usage with them when it returns.
const withAgentWork = (recording: Recording, agent: AgentReturn, pick: Pick): Recording => {
  const requested = withRequests(recording, agent.model, 6 + pick(6), pick)
  return addSubagentUsage(withToolCalls(requested.recording, pick), requested.usage)
}

type Spawned = StoryTurn['spawned'][number]

const withSpawns = (recording: Recording, spawned: readonly Spawned[]): Recording =>
  spawned.reduce((spawning, agent) => addAgentSpawn(spawning, 'sidequest:worker', { agentId: agent.agentId, model: agent.model }), recording)

const routesOf = (spawned: readonly Spawned[]): Record<string, RoutedRun> => Object.fromEntries(spawned.map(agent => [agent.agentId, agent.run]))

// A turn the person did not type has no prompt to name it.
const withWords = (recording: Recording, words: string): Recording => (words === '' ? recording : notePrompt(recording, words))

type LedgerTurn = {
  session: string
  startedAt: number
  startsAt: number
  endsAt: number
  turn: number
  words: string
  spawned: readonly Spawned[]
  agentReturns: readonly AgentReturn[]
  blockedRuns: number
}

const contextOf = (pick: Pick) => {
  const contextTokens = 30_000 + pick(120_000)
  return { tokens: contextTokens, window: 200_000, percent: Math.round(contextTokens / 2000) }
}

// Everything the turn did, in the order the hooks hear it, on top of what the turn before carried over.
const turnRecording = (carried: Recording, turn: LedgerTurn, pick: Pick): Requested => {
  const requested = withRequests(withWords(carried, turn.words), madeUp.SESSION_MODEL, 2 + pick(5), pick)
  const worked = turn.agentReturns.reduce((working, agent) => withAgentWork(working, agent, pick), withToolCalls(requested.recording, pick))
  const blocked = Array.from({ length: turn.blockedRuns }).reduce<Recording>(withBlockedRun, worked)

  return { recording: withSpawns(blocked, turn.spawned), usage: requested.usage }
}

type RecordedTurn = { row: TurnRow; folded: Recording }

function recordedTurn(carried: Recording, turn: LedgerTurn, pick: Pick): RecordedTurn {
  const { recording, usage } = turnRecording(carried, turn, pick)
  const cost = { usd: carried.costUsd + 0.05 + pick(140) / 100 }
  const end: TurnEnd = {
    at: new Date(turn.endsAt).toISOString(),
    project: projectSlug(madeUp.USAGE_PROJECT_PATH),
    session: turn.session,
    startedAt: turn.startedAt,
    turn: turn.turn,
    reason: 'answer',
    durationMs: Math.max(MINUTE, turn.endsAt - turn.startsAt),
    usage,
    sessionUsage: { startedAt: turn.startedAt, context: contextOf(pick), rateLimits: [], cost },
    model: madeUp.SESSION_MODEL,
    version: madeUp.CLAUDE_VERSION,
  }

  return { row: foldTurn(recording, end, turn.spawned.length === 0 ? undefined : routesOf(turn.spawned)), folded: recording }
}

const TURN_LENGTH = 6 * MINUTE

// Spread over the working day, first turn at its start and last at its end.
const earlierSessionTurns = (earlier: (typeof madeUp.EARLIER_SESSIONS)[number]): LedgerTurn[] => {
  const startedAt = Date.parse(`${earlier.day}T09:00:00Z`)
  const spacing = WORKDAY / (earlier.turns - 1)

  return Array.from({ length: earlier.turns }, (_, index) => ({
    session: `session-${earlier.day.slice(5)}`,
    startedAt,
    startsAt: startedAt + index * spacing,
    endsAt: startedAt + index * spacing + TURN_LENGTH,
    turn: index + 1,
    words: index === 0 ? earlier.prompt : '',
    spawned: [],
    agentReturns: [],
    blockedRuns: 0,
  }))
}

type TurnWindow = { after: number; until: number }

const isWithin = (window: TurnWindow, at: number): boolean => at > window.after && at <= window.until

const BLOCKED_AT = madeUp.DENIED_RUNS.map(at => Date.parse(at))

// Each turn lasts until the next one starts, the last one until the story's last step. What happens while a turn is
// open lands in it, as everything the hooks hear lands in the one recording the next turn end folds.
const storySessionTurns = (story: PlayedStory): LedgerTurn[] =>
  story.turns.map((turn, index) => {
    const window = { after: index === 0 ? -Infinity : turn.at, until: story.turns[index + 1]?.at ?? story.endsAt }

    return {
      session: PAY_41_SESSION,
      startedAt: madeUp.FIRST_MINUTE,
      startsAt: turn.at,
      endsAt: window.until,
      turn: index + 1,
      words: turn.words,
      spawned: turn.spawned,
      agentReturns: story.agentReturns.filter(agent => isWithin(window, agent.at)),
      blockedRuns: BLOCKED_AT.filter(at => isWithin(window, at)).length,
    }
  })

type LedgerLines = Map<string, string>

function writeSession(ledger: LedgerLines, folder: string, turns: readonly LedgerTurn[], pick: Pick): void {
  let carried = freshRecording()
  for (const turn of turns) {
    const file = sessionLedgerFile(folder, projectSlug(madeUp.USAGE_PROJECT_PATH), turn.session)
    const { row, folded } = recordedTurn(carried, turn, pick)
    carried = carryOverIntoNextTurn(folded, row.costUsd)
    ledger.set(file, appendLine(ledger.get(file) ?? '', row))
  }
}

function writeTheLedger(configFolder: string, story: PlayedStory): string {
  const folder = ledgerFolderOf(configFolder)
  const pick = numbersFrom(madeUp.USAGE_SEED)
  const ledger: LedgerLines = new Map()
  for (const earlier of madeUp.EARLIER_SESSIONS) writeSession(ledger, folder, earlierSessionTurns(earlier), pick)
  writeSession(ledger, folder, storySessionTurns(story), pick)
  for (const [file, text] of ledger) writeText(file, text)

  return folder
}

const rowsIn = (folder: string, now: number) =>
  readdirSync(folder)
    .filter(isLedgerFileName)
    .sort()
    .flatMap(name => rowsSince(readFileSync(`${folder}/${name}`, 'utf8'), now - PAGE_DAYS * DAY))

// The page reads its clock in the viewer's time zone, and Chrome on Windows ignores TZ. Run before the page's own
// script, this makes the browser's local time UTC, so every machine takes the same picture.
const UTC_CLOCK = `<script>(() => {
  const LocalDate = Date
  const WITHOUT_ZONE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$/
  const inUtc = text => (typeof text === 'string' && WITHOUT_ZONE.test(text) ? text + 'Z' : text)
  class UtcDate extends LocalDate {
    constructor(...parts) {
      if (parts.length > 1) super(LocalDate.UTC(...parts))
      else if (parts.length === 1) super(inUtc(parts[0]))
      else super()
    }
    static parse(text) { return LocalDate.parse(inUtc(text)) }
  }
  for (const part of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    UtcDate.prototype['get' + part] = LocalDate.prototype['getUTC' + part]
    if (part !== 'Day') UtcDate.prototype['set' + part] = LocalDate.prototype['setUTC' + part]
  }
  UtcDate.prototype.getTimezoneOffset = () => 0
  globalThis.Date = UtcDate
})()</script>`

const withUtcClock = (page: string): string => {
  if (!page.includes('<head>')) throw new Error('the usage page has no <head> to set its clock in')
  return page.replace('<head>', `<head>${UTC_CLOCK}`)
}

/** The page as it reads an hour after the story's last step, in UTC. */
export function usagePage(configFolder: string, story: PlayedStory): string {
  const now = story.endsAt + HOUR
  const folder = writeTheLedger(configFolder, story)

  return withUtcClock(boardHtml(rowsIn(folder, now), now))
}
