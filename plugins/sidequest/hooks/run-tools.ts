import { LOG_NAMES, logTextOf, logTextsSinceLastStart } from './agent-returns'
import { blockerWaits } from './blocked-work'
import { briefFor } from './brief'
import type { BoardConfig } from './board-config'
import { wasCutOffHere } from './interrupted-work'
import { effortLevelOf, fallbackCategoryOf, isClaudeAlias, resolveRoute } from './routing'
import type { ClaudeAlias, EffortLevel, Providers, Route } from './routing'
import { namesARepository, noGitAnswerNote } from './own-worktree'
import { isUnderPlanWaitingForYes, PLAN_WAITS_FOR_YES, storiesWaitingForYes } from './proposed-tickets'
import type { WithoutGit } from './own-worktree'
import { NO_PAIRS_SAID, noticeOnItsOwnLine, sameFilesNotice, sameKeyNotice } from './leftover-conflicts'
import type { BranchOverlap } from './leftover-conflicts'
import { FINISH_OUTCOMES, isFinishOutcome, namesANeed, NOT_RECORDED, readFinishOutcome, statusAfter } from './run-outcome'
import type { FinishOutcome } from './run-outcome'
import type { ResumeFacts } from './resume-facts'
import { heldThingsFor } from './shared-things'
import type { HeldThing } from './shared-things'
import { NOBODY_ELSE_ON_THE_KEY, someoneElseOnItLine } from './team-work'
import type { OthersOnTheKey } from './team-work'
import type { BoardFiles, BriefFile } from './store'
import { appendLogLine, applyTicketPatch, lastStartStamp, oneLine, runDuration, withChangedTickets } from './tickets'
import type { Story, Ticket } from './tickets'
import type { TicketToolResult } from './ticket-tool'
import { ignoredFieldsNote, isTextList, textOf } from './tool-input'
import type { JsonRecord } from './tool-input'
import { checkedSinceLastStart, NOTHING_WAS_CHECKED, saysNothingWasChecked } from './nothing-checked'
import { nowWaitingNote, waitingAroundWrite } from './waiting-view'
import { reviewRouteOf, waveAnswerText, waveEntryFor } from './wave-entry'
import type { ReviewRoute } from './wave-entry'
import { alongsideNote, startableTickets } from './what-can-move'

export type AgentCall = {
  subagent_type: string
  description: string
  name: string
  prompt: string
  model?: ClaudeAlias
  effort?: EffortLevel
  isolation?: 'worktree'
}

const START_FIELDS = ['id', 'delivery', 'alongside', 'forWave']

const FINISH_FIELDS = ['id', 'outcome', 'result', 'checked', 'uncertain', 'needs', 'branch', 'commits', 'changedFiles'] as const

const RETURN_IS_LOGGED =
  'The board logs what the agent returns on the ticket by itself; call finish when it returns to add what you checked and move the ticket.'

const refused = (refusal: string): TicketToolResult => ({ answer: { refusal } })

const findTicket = (files: BoardFiles, input: JsonRecord): Ticket | undefined => {
  const id = textOf(input, 'id')

  return files.tickets.find(ticket => ticket.id === id)
}

const notOnBoard = (input: JsonRecord): TicketToolResult =>
  refused(`No ticket ${textOf(input, 'id') ?? '(no id given)'} on this board. The board tool's list view shows every id.`)

const shortDescription = (ticket: Ticket): string => `${ticket.id} ${ticket.title.split(/\s+/).slice(0, 4).join(' ')}`

// When the ticket's own category has no route, the tag carries the one it runs on, so the spawn hook routes and
// records it the same way. The ref leads, as a workflow stage's does, because only a leading ref routes.
type BriefParts = { story?: Story; delivery?: string; resume?: ResumeFacts; noGitFolder?: string; branchToMerge?: string }

const isIsolatedOn = (route: Route, config: BoardConfig): boolean => route.role === 'worker' && config.settings.worktrees

const briefTextFor = (ticket: Ticket, route: Route, config: BoardConfig, parts: BriefParts): string =>
  briefFor(ticket, parts.story, parts.delivery, { config, isIsolated: isIsolatedOn(route, config), branchToMerge: parts.branchToMerge }, parts.resume, parts.noGitFolder)

const promptFor = (ticket: Ticket, route: Route, brief: string): string =>
  route.category === ticket.category ? brief : `${ticket.id} [route:${route.category}] ${brief}`

export const agentCallFor = (ticket: Ticket, route: Route, config: BoardConfig, parts: BriefParts = {}): AgentCall => {
  const effort = effortLevelOf(route.effort)
  const isIsolated = isIsolatedOn(route, config) && parts.noGitFolder === undefined

  return {
    subagent_type: `sidequest:${route.role}`,
    description: shortDescription(ticket),
    name: ticket.id.toLowerCase(),
    prompt: promptFor(ticket, route, briefTextFor(ticket, route, config, parts)),
    ...(isClaudeAlias(route.model) ? { model: route.model } : {}),
    ...(effort ? { effort } : {}),
    ...(isIsolated ? { isolation: 'worktree' } : {}),
  }
}

type StartRoute = { route: Route; categoryReason?: string }

const startRouteFor = (ticket: Ticket, config: BoardConfig, providers: Providers): StartRoute | undefined => {
  const own = resolveRoute(ticket.category, config, providers)
  if (own) return { route: own }
  const fallback = fallbackCategoryOf(config)
  const route = fallback === undefined ? undefined : resolveRoute(fallback, config, providers)

  return route && { route, categoryReason: `category "${ticket.category}" has no route on this board, so it runs as ${route.category}` }
}

const heldWords = (held: readonly HeldThing[]): string =>
  held.map(({ thing, holder }) => `the ${thing} was held by ${holder.id}`).join(', ')

const alongsidePart = (held: readonly HeldThing[]): string[] => (held.length === 0 ? [] : [`started alongside: ${heldWords(held)}`])

// Seen 2026-11-20: a second start answered word for word like the first and logged the same line again, so two agents
// ended up on one ticket and nothing said so. An interrupted ticket started again is a resume, which has its own answer.
// A start the same session repeats because nothing ever became an agent from it (the brief was read, the ticket
// patched, start called again) is the same start again, not a second one: it is answered as that and not logged as a repeat.
type RepeatStart = { startedAt: string | undefined; isAgentOfThisSessionOnIt: boolean; neverBecameAnAgent: boolean }

type StartRequest = {
  start: StartRoute
  delivery: string | undefined
  ignoredNote: string
  isAlongside: boolean
  resume?: ResumeFacts
  withoutGit?: WithoutGit
  branchToMerge?: string
  repeat?: RepeatStart
  saidPairs: ReadonlySet<string>
  othersOnIt: OthersOnTheKey
  briefPath?: string
  keptBriefPath?: string
  reviewRoute: ReviewRoute
}

const repeatLogPart = (repeat: RepeatStart | undefined): string | undefined =>
  repeat === undefined || repeat.neverBecameAnAgent ? undefined : `repeat start${repeat.startedAt === undefined ? '' : `, already started ${repeat.startedAt}`}`

const startLogLine = (request: StartRequest, held: readonly HeldThing[]): string => {
  const { route, categoryReason } = request.start
  const parts = [`started ${route.role} ${route.model}/${route.effort}`, route.reason, categoryReason, repeatLogPart(request.repeat), ...alongsidePart(held)]
  const routed = parts.filter(part => part !== undefined).join('. ')

  return request.delivery ? `${routed}. delivery ${JSON.stringify(oneLine(request.delivery))}` : routed
}

const agentCallText = (call: AgentCall): string => `Make this Agent call as given:\n${JSON.stringify(call, null, 2)}`

// Measured on 2026-11-22: a review brief written by hand carried 0, 0 and 1 of a story's decisions in three real
// sessions, so the reviewer is pointed at the brief the worker got.
const keptBriefNote = (ticket: Ticket, request: StartRequest): string =>
  request.keptBriefPath === undefined || ticket.kind !== 'build'
    ? ''
    : `\nThe brief is also kept in ${request.keptBriefPath}: name that file to the reviewer and to whoever proves the story, so they read the same decisions and how checks run here.`

const answerBodyFor = (ticket: Ticket, call: AgentCall, request: StartRequest): string =>
  request.briefPath === undefined
    ? `${agentCallText(call)}${keptBriefNote(ticket, request)}`
    : waveAnswerText(waveEntryFor(ticket, request.start.route, call, request.briefPath), request.reviewRoute)

const briefFileOf = (ticket: Ticket, route: Route, files: BoardFiles, request: StartRequest, parts: BriefParts): { briefFile?: BriefFile } =>
  request.keptBriefPath === undefined ? {} : { briefFile: { ticketId: ticket.id, text: briefTextFor(ticket, route, files.config, parts) } }

const whoIsOnIt = (repeat: RepeatStart): string =>
  repeat.isAgentOfThisSessionOnIt
    ? 'An agent of this session is on it right now.'
    : 'No agent of this session is on it. An agent of another session may be, and this session cannot know.'

const neverBecameAnAgentNote = (ticket: Ticket, when: string): string =>
  `${ticket.id} was started${when}, but that start never became an agent, so nothing is on it. This is the brief again, built from the ticket as it is now: make the Agent call below.`

const repeatStartNote = (ticket: Ticket, repeat: RepeatStart): string => {
  const when = repeat.startedAt === undefined ? '' : ` at ${repeat.startedAt}`
  if (repeat.neverBecameAnAgent) return neverBecameAnAgentNote(ticket, when)

  return `${ticket.id} was already started${when}. ${whoIsOnIt(repeat)} Nothing is refused: the Agent call below puts a second agent on the same ticket, so make it only if you want two.`
}

const leadOf = (ticket: Ticket, request: StartRequest): string => {
  const categoryNote = request.start.categoryReason ? ` Its ${request.start.categoryReason}.` : ''
  const lead = `${ticket.id} is now doing.${categoryNote}${request.ignoredNote} ${RETURN_IS_LOGGED}`

  return request.repeat === undefined ? lead : `${repeatStartNote(ticket, request.repeat)} ${lead}`
}

// Nothing is refused: a start the person asked for runs. The answer only says what the board shows before the call.
const blockerNote = (ticket: Ticket, files: BoardFiles): string[] => {
  const waits = blockerWaits(ticket, files.tickets, files.config.settings.worktrees)

  return waits.length === 0 ? [] : [`${ticket.id} ${waits.map(wait => wait.words).join(', and ')}. It is started all the same.`]
}

const REOPENED_STATUSES = ['done', 'dropped']

const reopenedNote = (ticket: Ticket): string[] =>
  REOPENED_STATUSES.includes(ticket.status) ? [`${ticket.id} was ${ticket.status}: this start puts it back to doing.`] : []

const withoutGitNote = (ticket: Ticket, withoutGit: WithoutGit | undefined): string[] =>
  withoutGit === undefined ? [] : [noGitAnswerNote(namesARepository(ticket, withoutGit.repositoryFolders))]

const startLeadOf = (ticket: Ticket, files: BoardFiles, request: StartRequest): string =>
  [...reopenedNote(ticket), ...blockerNote(ticket, files), leadOf(ticket, request), ...withoutGitNote(ticket, request.withoutGit)].join(' ')

const withoutLastStartLine = (ticket: Ticket): Ticket => {
  const at = ticket.log.map(logTextOf).findLastIndex(text => text.startsWith('started '))

  return { ...ticket, log: ticket.log.filter((_, index) => index !== at) }
}

const loggedStart = (ticket: Ticket, stamp: string, request: StartRequest, held: readonly HeldThing[]): Ticket => {
  const base = request.repeat?.neverBecameAnAgent === true ? withoutLastStartLine(ticket) : ticket

  return appendLogLine(applyTicketPatch(base, { status: 'doing' }, stamp), stamp, startLogLine(request, held))
}

const startedResult = (ticket: Ticket, files: BoardFiles, stamp: string, request: StartRequest, held: readonly HeldThing[]): TicketToolResult => {
  const { start, delivery, resume, withoutGit } = request
  const story = files.stories.find(one => one.id === ticket.story)
  const parts = { story, delivery, resume, noGitFolder: withoutGit?.folder, branchToMerge: request.branchToMerge }
  const call = agentCallFor(ticket, start.route, files.config, parts)
  const started = loggedStart(ticket, stamp, request, held)
  const modelNote = call.model ? '' : `\nThe routing hook sets model ${start.route.model} from the ticket ref in the prompt.`
  const sharedNote = alongsideNote(started, withChangedTickets(files.tickets, [started]), files.config)
  const sameKey = sameKeyNotice([ticket], files.tickets, request.saidPairs)
  const notes = `${modelNote}${sharedNote}${noticeOnItsOwnLine(sameKey)}${someoneElseOnItLine(ticket, request.othersOnIt)}`

  return {
    answer: { text: `${startLeadOf(ticket, files, request)} ${answerBodyFor(ticket, call, request)}${notes}` },
    change: { tickets: [started], stories: [] },
    sessionWork: [ticket.id],
    conflictPairs: sameKey.pairs,
    ...briefFileOf(ticket, start.route, files, request, parts),
    ...(call.isolation === 'worktree' ? { madeWorktree: true } : {}),
  }
}

const readyInstead = (tickets: readonly Ticket[]): string =>
  tickets.length === 0 ? '' : ` Ready now without waiting: ${tickets.map(ticket => ticket.id).join(', ')}.`

// Two workers writing in one checkout lost work in the 2026-11-19 baseline, so this is answered, not started. One
// field gets past it, and the log says so.
const heldAnswer = (ticket: Ticket, held: readonly HeldThing[], files: BoardFiles): TicketToolResult => {
  const free = startableTickets(files.tickets, files.config).free
  const uses = held.map(({ thing, holder }) => `the ${thing}, and ${holder.id} has it`).join('; ')

  return refused(
    `${ticket.id} was not started: it uses ${uses}. Start it once that is done, or call start again with alongside: true to start it anyway; its log then says it started while ${heldWords(held)}.${readyInstead(free)}`,
  )
}

const startOrAnswerHeld = (ticket: Ticket, files: BoardFiles, stamp: string, request: StartRequest): TicketToolResult => {
  const held = heldThingsFor(ticket, files.tickets, files.config)
  if (held.length > 0 && !request.isAlongside) return heldAnswer(ticket, held, files)

  return startedResult(ticket, files, stamp, request, held)
}

const isAlongsideIn = (input: JsonRecord): boolean => input.alongside === true || input.alongside === 'true'

const isForWaveIn = (input: JsonRecord): boolean => input.forWave === true || input.forWave === 'true'

// What the board read before the write: git facts for an interrupted ticket, the conflicts already said, and who
// else the remote and the tracker show on the same tracker key.
// isAgentOfThisSessionOnIt is whether this session's own record of live agents has one on the ticket.
export type StartFacts = {
  resume?: ResumeFacts
  saidPairs?: ReadonlySet<string>
  othersOnIt?: OthersOnTheKey
  briefPath?: string
  isAgentOfThisSessionOnIt?: boolean
  withoutGit?: WithoutGit
  hasRemote?: boolean
}

const SPAWN_LINE = /^agent \S+ /

// The spawn line is written on the ticket's log when an agent starts on it, whoever's session that is, so a log with
// none after its last start, and that start not a repeat, holds a start nothing came of.
const isStartWithNoAgentAfterIt = (ticket: Ticket): boolean => {
  const texts = ticket.log.map(logTextOf)
  const at = texts.findLastIndex(text => text.startsWith('started '))

  return at !== -1 && !texts[at]?.includes('repeat start') && !texts.slice(at + 1).some(text => SPAWN_LINE.test(text))
}

const repeatStartOf = (ticket: Ticket, facts: StartFacts): RepeatStart | undefined => {
  if (ticket.status !== 'doing' || wasCutOffHere(ticket)) return undefined
  const isAgentOfThisSessionOnIt = facts.isAgentOfThisSessionOnIt === true

  return {
    startedAt: lastStartStamp(ticket.log),
    isAgentOfThisSessionOnIt,
    neverBecameAnAgent: !isAgentOfThisSessionOnIt && isStartWithNoAgentAfterIt(ticket),
  }
}

const startRequestOf = (input: JsonRecord, start: StartRoute, facts: StartFacts, reviewRoute: ReviewRoute, ticket: Ticket, files: BoardFiles): StartRequest => ({
  start,
  repeat: repeatStartOf(ticket, facts),
  delivery: textOf(input, 'delivery')?.trim(),
  ignoredNote: ignoredFieldsNote(input, START_FIELDS),
  isAlongside: isAlongsideIn(input),
  resume: facts.resume,
  withoutGit: facts.withoutGit,
  branchToMerge: facts.hasRemote === true ? files.checkedOutBranch : undefined,
  saidPairs: facts.saidPairs ?? NO_PAIRS_SAID,
  othersOnIt: facts.othersOnIt ?? NOBODY_ELSE_ON_THE_KEY,
  briefPath: isForWaveIn(input) ? facts.briefPath : undefined,
  keptBriefPath: facts.briefPath,
  reviewRoute,
})

// Also when the person did say yes and the session forgot to clear the mark: the refusal says how.
const planWaitsRefusal = (ticket: Ticket): string =>
  `${ticket.id} was not started: ${PLAN_WAITS_FOR_YES}. Nothing of a plan starts before it. If they said yes, patch ${ticket.story ?? 'its story'} with awaitsYes false, then start.`

export const startTicket = (
  input: JsonRecord,
  files: BoardFiles,
  providers: Providers,
  stamp: string,
  facts: StartFacts = {},
): TicketToolResult => {
  const ticket = findTicket(files, input)
  if (!ticket) return notOnBoard(input)
  if (ticket.mode === 'hitl') return refused(`${ticket.id} is hitl: it needs the human, so it is never dispatched. Patch mode to afk to run it.`)
  if (isUnderPlanWaitingForYes(ticket, storiesWaitingForYes(files.stories))) return refused(planWaitsRefusal(ticket))
  const start = startRouteFor(ticket, files.config, providers)
  if (!start) return refused(`No category on this board has a route, so ${ticket.id} has nothing to run on. Fix the tiers in .sidequest/board.json.`)

  return startOrAnswerHeld(ticket, files, stamp, startRequestOf(input, start, facts, reviewRouteOf(resolveRoute('review', files.config, providers)), ticket, files))
}

// finish takes what it is given: a number, a list or a text all read as the text the log holds.
const looseTextOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)

  return isTextList(value) ? value.join(', ') : undefined
}

type FinishFields = Partial<Record<(typeof FINISH_FIELDS)[number], string>>

const finishFieldsOf = (input: JsonRecord): FinishFields =>
  Object.fromEntries(FINISH_FIELDS.flatMap(key => {
    const value = looseTextOf(input[key])

    return value === undefined || value.trim() === '' ? [] : [[key, value]]
  }))

// The return record may already hold the same check; the log says it once.
const checkedPart = (checked: string | undefined, logged: readonly string[]): string =>
  checked === undefined || logged.includes(`checked ${oneLine(checked)}`) ? '' : `checked ${JSON.stringify(oneLine(checked))}`

const finishHeadLine = (fields: FinishFields, outcome: FinishOutcome, log: readonly string[]): string => {
  const parts = [
    `finished ${outcome}`,
    fields.branch ? `branch ${fields.branch}` : '',
    fields.commits ? `commits ${fields.commits}` : '',
    checkedPart(fields.checked, logTextsSinceLastStart(log)),
  ]

  return parts.filter(part => part !== '').join(' ')
}

const DETAIL_FIELDS = ['result', 'uncertain', 'needs', 'changedFiles'] as const

const isWorthLogging = (key: string, value: string | undefined): value is string =>
  value !== undefined && !(key === 'needs' && !namesANeed(value))

const detailLine = (fields: FinishFields, key: (typeof DETAIL_FIELDS)[number]): string[] => {
  const value = fields[key]

  return isWorthLogging(key, value) ? [`${LOG_NAMES[key]} ${oneLine(value)}`] : []
}

const hasLoggedResult = (logged: readonly string[]): boolean => logged.some(text => text.startsWith('result '))

const missingResultLine = (fields: FinishFields, logged: readonly string[]): string[] =>
  fields.result === undefined && !hasLoggedResult(logged) ? [`result ${NOT_RECORDED}`] : []

// A line the board already wrote when the agent returned is not written again.
const finishDetailLines = (fields: FinishFields, log: readonly string[]): string[] => {
  const logged = logTextsSinceLastStart(log)
  const lines = [...DETAIL_FIELDS.flatMap(key => detailLine(fields, key)), ...missingResultLine(fields, logged)]

  return lines.filter(line => !logged.includes(line))
}

const outcomeNote = (outcomeWord: string | undefined, outcome: FinishOutcome): string => {
  if (isFinishOutcome(outcomeWord)) return ''
  const given = outcomeWord === undefined ? 'No outcome was given' : `outcome "${outcomeWord}" is not one of ${FINISH_OUTCOMES.join(', ')}`

  return ` ${given}, so it was read as ${outcome}.`
}

const resultNote = (fields: FinishFields): string => (fields.result === undefined ? ' No result was given.' : '')

const finishAnswer = (ticket: Ticket, status: string, stamp: string, notes: string): string => {
  const duration = runDuration(ticket.log, stamp)

  return `${ticket.id} moved to ${status}${duration ? ` after ${duration}` : ''}.${notes}`
}

const NO_VERIFY_LINE =
  "No verify command is set. If this ticket's check is the project's check, put it in settings.verify in .sidequest/board.json."

const reachesReviewOrDone = (status: string): boolean => status === 'review' || status === 'done'

const verifyNote = (ticket: Ticket, status: string, files: BoardFiles): string => {
  const firstToFinish = !files.tickets.some(other => other.id !== ticket.id && reachesReviewOrDone(other.status))
  const isMissing = files.config.settings.verify === '' && reachesReviewOrDone(status) && firstToFinish

  return isMissing && ticket.kind === 'build' ? ` ${NO_VERIFY_LINE}` : ''
}

// A branch the host named is temporary and comes home; a local branch someone chose is where the ticket's work now is.
// No fact from git, no write.
const chosenBranchPatch = (existingBranch: string | undefined): { branch?: string } =>
  existingBranch === undefined ? {} : { branch: existingBranch }

// What the board read from git before the write: open tickets whose unmerged branch changed the same files, and the
// branch a finish named when a local branch of that name exists.
export type FinishFacts = { overlaps: readonly BranchOverlap[]; saidPairs: ReadonlySet<string>; existingBranch?: string; touchedThisSession?: ReadonlySet<string> }

const NO_FINISH_FACTS: FinishFacts = { overlaps: [], saidPairs: NO_PAIRS_SAID }

const isUncheckedFinish = (fields: FinishFields, ticket: Ticket, status: string): boolean =>
  reachesReviewOrDone(status) && saysNothingWasChecked(fields.checked ?? checkedSinceLastStart(ticket.log))

const finishLogLines = (fields: FinishFields, outcome: FinishOutcome, log: readonly string[], isUnchecked: boolean): string[] => [
  finishHeadLine(fields, outcome, log),
  ...finishDetailLines(fields, log),
  ...(isUnchecked ? [NOTHING_WAS_CHECKED] : []),
]

const UNCHECKED_NOTE =' Nothing was checked, so nobody has seen this work pass a check yet.'

const finishWaitingNote = (finished: Ticket, files: BoardFiles, facts: FinishFacts, stamp: string): string =>
  nowWaitingNote([finished], withChangedTickets(files.tickets, [finished]), waitingAroundWrite(files, facts.touchedThisSession ?? new Set(), [finished.id], stamp))

export const finishTicket = (input: JsonRecord, files: BoardFiles, stamp: string, facts: FinishFacts = NO_FINISH_FACTS): TicketToolResult => {
  const ticket = findTicket(files, input)
  if (!ticket) return notOnBoard(input)
  const fields = finishFieldsOf(input)
  const outcome = readFinishOutcome(fields)
  const status = statusAfter(outcome, ticket)
  const isUnchecked = isUncheckedFinish(fields, ticket, status)
  const lines = finishLogLines(fields, outcome, ticket.log, isUnchecked)
  const finished = lines.reduce((current, line) => appendLogLine(current, stamp, line), applyTicketPatch(ticket, { status, ...chosenBranchPatch(facts.existingBranch) }, stamp))
  const waitingNote = status === 'needs-you' ? finishWaitingNote(finished, files, facts, stamp) : ''
  const sameFiles = sameFilesNotice(ticket, facts.overlaps, files.tickets, facts.saidPairs)
  const uncheckedNote = isUnchecked ? UNCHECKED_NOTE : ''
  const notes = `${outcomeNote(fields.outcome, outcome)}${resultNote(fields)}${ignoredFieldsNote(input, FINISH_FIELDS)}${verifyNote(ticket, status, files)}${uncheckedNote}${waitingNote}${noticeOnItsOwnLine(sameFiles)}`

  return {
    answer: { text: finishAnswer(ticket, status, stamp, notes) },
    change: { tickets: [finished], stories: [] },
    sessionWork: [ticket.id],
    conflictPairs: sameFiles.pairs,
  }
}
