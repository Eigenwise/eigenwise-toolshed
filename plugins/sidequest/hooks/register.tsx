import { atom, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, Frozen, Hook, On, Register, ToolCallResult } from 'claude-code'

import { boardFoundFrom, boardLocation, handOnChatEnding, handOnPathToPlace, handOnTicketsAfterWrite, handOnViewToShow, publishSummary, queueBoardWrite, rememberBoardLocation } from './board-session'
import type { ViewAfterWrite } from './board-session'
import { otherBoardNote } from './board-root'
import { BOARD_JSON_ON_READ, BOARD_JSON_ON_WRITE, brokenBoardJsonNotice, forgetNoticesSaid, sayOnce, VANISHED_BOARD, wasSaid } from './board-notices'
import { answerBoardView, viewNamesBoardJsonProblems } from './board-tool'
import { boardToolRefusal, causeOf } from './failure-cause'
import { clearPermissionWait, forgetPermissionWait, isWaitingOnPermission, notePermissionWait } from './permission-waits'
import { rememberSessionChanges, sessionChanges, ticketsTouchedThisSession } from './register-closing-report'
import { registerCompactionLine, rememberRerouteLine, rememberSessionWork } from './register-compaction'
import { removeSafeLeftovers } from './register-drop'
import { interruptedWorkOn, isAgentOfThisSessionOn, resumeFactsForStart, workWithNoAgentHereOn } from './register-interrupted'
import { branchOverlapsForFinish, conflictPairsSaid, existingBranchForFinish, rememberConflictPairs } from './register-leftover-conflicts'
import { recordReturnsLeftBehind, recordTurnEnd, registerReturnRecords } from './register-returns'
import { hasRemote, othersOnTheKeyFor, teamFactsForView } from './register-team-work'
import { NO_TEAM_FACTS } from './team-work'
import { noteToolStart, noteTurnEnd, noteTurnStep } from './register-session-work'
import {
  effortLevelOf,
  fallbackReasonToAnnounce,
  fallbackToast,
  rerouteContextLine,
  routedRunOf,
  routeRequestFor,
  setsModelAndEffort,
  spawnLogLine,
  spawnLogReason,
  spawnRouteFor,
} from './routing'
import type { EffortLevel, SpawnRoute, SpawnShape } from './routing'
import { withoutGitFor } from './repository-folders'
import { finishTicket, startTicket } from './run-tools'
import type { StartFacts } from './run-tools'
import { createdThisSession, currentTurnWords, noteSessionStart, rememberCreatedTickets, tellPersonOfUnaskedStarts } from './register-whose-words'
import { boardIdsOf, EARLIER_BOARD_IDS } from './board-ids'
import {
  briefPathOf,
  excludeWorktreesFromGit,
  changeTicketFile,
  keepBriefFile,
  readBoard,
  readBoardConfig,
  readIdsToDescribe,
  readPrefixFacts,
  readProviders,
  readBoardForWrite,
  readTicket,
  readVanishedBoardNotice,
  writeBoardDecision,
} from './store'
import type { BoardFiles, BoardLocation, BoardRead, DecidedWrite, SavedChange } from './store'
import { answerLeavingOut, applyTicketOperations } from './ticket-tool'
import type { SessionTurn, TicketToolResult } from './ticket-tool'
import { withTurnRecord } from './whose-words'
import { NO_INTERRUPTED_WORK } from './interrupted-work'
import { appendLogLine, minuteStamp, withChangedTickets } from './tickets'
import { textOf } from './tool-input'
import type { JsonRecord, ToolAnswer } from './tool-input'
import type { LiveAgent } from '../types'
import { sidequestToolsOn } from './tool-specs'
import { rememberRunningPlugin, warnWhenOutdated } from './register-staleness'
import { askedIn } from './views/finished-agents'
import { registerViews, showTickets, startBoardViews } from './views/register-views'
import { senseWorktrees } from './register-worktrees'

// The host only follows a state name declared in the file that uses it, so each file names its own. The shape tags
// decline what an earlier version stored, which outlives a reload: change one in every file when its fields change.
const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })
const permissionWaits = atom({ plugin: 'sidequest', key: 'permissionWaits' } as const, {})

const ownToolFailed = (cause: string): ToolCallResult => ({ deny: boardToolRefusal(cause) })

// turn.step runs on every model request, so the tier effort of routed agents is kept here for one lookup.
// The permission waits it clears are a second in-memory lookup, for the same reason.
const routedAgentEfforts = new Map<string, EffortLevel>()

// agent.spawn never sees an Agent call's effort, so the calls that named one are kept here by their id until their
// agent spawns.
const agentCallsNamingEffort = new Set<string>()

let reroutesThisTurn: { count: number; model: string; category: string } | undefined
const fallbackReasonsThisTurn = new Set<string>()

type StartedAgent = { agentId: string; model: string }

const stampNow = async ($: EngineInterface): Promise<string> => minuteStamp(await $.clock.now())

const toolResultOf = (answer: ToolAnswer): ToolCallResult =>
  'text' in answer ? { result: answer.text } : { deny: answer.refusal }

const sessionTurn = (): SessionTurn => ({
  words: currentTurnWords(),
  ticketsThisSessionCreated: createdThisSession(),
  ticketsThisSessionTouched: ticketsTouchedThisSession(),
})

type RecordedOutcome = TicketToolResult & { startedUnasked: string[] }

// Part of the decision, so a write redone on a ticket that changed on disk records the turn on the new text too.
const withTurnRecordOf = (outcome: TicketToolResult, files: BoardFiles, stamp: string): RecordedOutcome => {
  if (!outcome.change) return { ...outcome, startedUnasked: [] }
  const recorded = withTurnRecord(files.tickets, outcome.change, currentTurnWords(), stamp)

  return { ...outcome, change: { ...outcome.change, tickets: recorded.tickets }, startedUnasked: recorded.startedUnasked }
}

const withNotice = (answer: ToolCallResult, notice: string | undefined): ToolCallResult =>
  notice !== undefined && typeof answer.result === 'string' ? { result: `${answer.result}\n${notice}` } : answer

const withWords = (answer: ToolCallResult, words: readonly string[]): ToolCallResult =>
  words.length === 0 ? answer : withNotice(answer, words.join(' '))

const withChatEndingLast = (answer: ToolCallResult, chatEnding: string): ToolCallResult =>
  chatEnding !== '' && typeof answer.result === 'string' ? { result: `${answer.result}${chatEnding}` } : answer

// A ticket filed under another id than the call decided is remembered under the id it has on disk.
const rememberWrite = (outcome: TicketToolResult, renamedIds: ReadonlyMap<string, string>): void => {
  const filedAs = (id: string): string => renamedIds.get(id) ?? id
  rememberSessionWork((outcome.sessionWork ?? []).map(filedAs))
  rememberCreatedTickets((outcome.createdTickets ?? []).map(filedAs))
  rememberConflictPairs(outcome.conflictPairs ?? [])
}

// Only a story that reached the disk is shown, under the id it was filed as.
const storyThatReachedDisk = (decided: string | undefined, saved: SavedChange): string | undefined => {
  const filedAs = decided === undefined ? undefined : (saved.renamedIds.get(decided) ?? decided)

  return saved.stories.some(story => story.id === filedAs) ? filedAs : undefined
}

const ticketThatReachedDisk = (decided: string | undefined, saved: SavedChange): string | undefined =>
  saved.tickets.some(ticket => ticket.id === decided) ? decided : undefined

const storyToShow = (decision: RecordedOutcome, saved: SavedChange): ViewAfterWrite | undefined => {
  // A correction to a proposed ticket writes the ticket alone, and the plan it belongs to is shown all the same.
  const story = storyThatReachedDisk(decision.storyWithAnalysis ?? decision.storyWithQuestions, saved) ?? decision.storyAwaitingYes

  return story === undefined ? undefined : { story, changedProposed: decision.proposedChanged ?? [] }
}

const viewToShow = (decision: RecordedOutcome, saved: SavedChange): ViewAfterWrite | undefined => {
  const ticket = ticketThatReachedDisk(decision.ticketWithCommitQuestion, saved)

  return storyToShow(decision, saved) ?? (ticket === undefined ? undefined : { ticket })
}

// Only a create says where it went, and only when the session left the project the board is in. A shell cd moves the
// working folder and /cd or a host's directory change moves the root, so either one counts.
async function otherBoardWords($: EngineInterface, location: BoardLocation, decision: RecordedOutcome): Promise<string[]> {
  if ((decision.createdTickets ?? []).length === 0) return []
  const folders = await Promise.all([$.session.cwd().catch(() => undefined), $.session.root().catch(() => undefined)])

  return folders.flatMap(folder => otherBoardNote(folder, location.root, boardFoundFrom()) ?? []).slice(0, 1)
}

const answerAfterWrite = async ($: EngineInterface, location: BoardLocation, written: DecidedWrite<RecordedOutcome>): Promise<ToolCallResult> => {
  const { files, decision, saved } = written
  const after = withChangedTickets(files.tickets, saved.tickets)
  handOnTicketsAfterWrite(after)
  if (!decision.change) return toolResultOf(decision.answer)
  rememberSessionChanges(files.tickets, saved.tickets)
  await publishSummary($, after)
  await tellPersonOfUnaskedStarts($, decision.startedUnasked)
  rememberWrite(decision, saved.renamedIds)
  handOnViewToShow(viewToShow(decision, saved))
  handOnPathToPlace(storyThatReachedDisk(decision.storyGivenAPath, saved))
  const removals = await removeSafeLeftovers($, decision.leftovers ?? [])
  const briefWords = await keepBriefFile($, location, decision.briefFile)
  const worktreeWords = await worktreeFolderWords($, location, decision)
  const brokenBoardJson = sayOnce(BOARD_JSON_ON_WRITE, brokenBoardJsonNotice(files))
  const otherBoard = await otherBoardWords($, location, decision)
  const answer = withNotice(toolResultOf(answerLeavingOut(decision, saved.notWritten)), saved.newBoardNotice)

  const withEveryNote = withWords(answer, [...saved.notes, ...brokenBoardJson, ...removals, ...briefWords, ...worktreeWords, ...otherBoard])

  // Written for no board; the drawing that follows swaps the ending when the board is placed.
  const chat = decision.chatEnding?.(saved.notWritten)
  handOnChatEnding(chat)

  return withChatEndingLast(withEveryNote, chat?.withNoBoard ?? '')
}

type Decide = (files: BoardFiles, stamp: string, location: BoardLocation) => TicketToolResult | Promise<TicketToolResult>

const writeBoardFrom = async ($: EngineInterface, location: BoardLocation, firstRead: BoardRead | undefined, decide: Decide): Promise<ToolCallResult> => {
  const stamp = await stampNow($)
  const written = await writeBoardDecision($, location, async files => withTurnRecordOf(await decide(files, stamp, location), files, stamp), firstRead)

  return answerAfterWrite($, location, written)
}

const writeBoard = ($: EngineInterface, decide: Decide): Promise<ToolCallResult> =>
  queueBoardWrite(async () => writeBoardFrom($, await boardLocation($), undefined, decide))

// Measured on 2026-11-20: a start on 2,000 tickets took 3.1 s, because the git facts, the tracker facts and the write
// each read the whole board. Now the start reads it once, inside the write queue, and hands it to all of them.
async function startFactsFor($: EngineInterface, location: BoardLocation, files: BoardFiles, input: JsonRecord): Promise<StartFacts> {
  const id = textOf(input, 'id')
  const ticket = files.tickets.find(one => one.id === id)
  const resume = await resumeFactsForStart($, location, files, ticket).catch(() => undefined)
  const othersOnIt = await othersOnTheKeyFor($, location, ticket).catch(() => undefined)
  const isAgentOfThisSessionOnIt = await isAgentOfThisSessionOn($, id).catch(() => false)
  const withoutGit = await withoutGitFor($, location)
  const isRemoteKnown = await hasRemote($, location).catch(() => false)

  return { resume, saidPairs: conflictPairsSaid(), othersOnIt, briefPath: briefPathOf(location, id ?? ''), isAgentOfThisSessionOnIt, withoutGit, hasRemote: isRemoteKnown }
}

// Seen on 2026-11-22: after the first worker, git status in the main checkout listed the folder its worktree is in,
// so a git add -A would stage a nested checkout. Only a start that asked for a worktree touches the exclude file.
async function worktreeFolderWords($: EngineInterface, location: BoardLocation, decision: RecordedOutcome): Promise<string[]> {
  if (decision.madeWorktree !== true) return []
  const notice = await excludeWorktreesFromGit($, location)

  return notice === undefined ? [] : [notice]
}

const startOnBoard = async ($: EngineInterface, input: JsonRecord): Promise<ToolCallResult> => {
  const providers = await readProviders($)

  return queueBoardWrite(async () => {
    const location = await boardLocation($)
    const firstRead = await readBoardForWrite($, location)
    const facts = await startFactsFor($, location, firstRead.files, input)

    return writeBoardFrom($, location, firstRead, (files, stamp) => startTicket(input, files, providers, stamp, facts))
  })
}

type SpawnTexts = { prompt: string; description: string }

const routeSpawn = async ($: EngineInterface, texts: SpawnTexts, shape: SpawnShape): Promise<SpawnRoute | undefined> => {
  const location = await boardLocation($)
  const [config, providers] = await Promise.all([readBoardConfig($, location), readProviders($)])
  const request = routeRequestFor(texts.prompt, texts.description, shape, config.settings, boardIdsOf(config.prefix))
  if (!request) return undefined
  const ticket = request.ticket === undefined ? undefined : await readTicket($, location, request.ticket)

  return spawnRouteFor(request, config, ticket, providers)
}

const logSpawnOnTicket = ($: EngineInterface, ticketId: string, line: string): Promise<void> =>
  queueBoardWrite(async () => {
    const stamp = await stampNow($)
    await changeTicketFile($, await boardLocation($), ticketId, ticket => appendLogLine(ticket, stamp, line))
  })

// A workflow's agents share the id of the Workflow call, so only an Agent call's own row can be matched to its run.
const agentCallIdOf = (e: Frozen<AgentSpawnInput>): { toolUseId?: string } =>
  e.workflow === undefined ? { toolUseId: e.tool_use_id } : {}

const recordRun = async ($: EngineInterface, e: Frozen<AgentSpawnInput>, spawn: SpawnRoute, agent: StartedAgent) => {
  const run = routedRunOf(spawn, agent.model, e.model)
  await update($, agentRuns, runs => ({ ...runs, [agent.agentId]: { ...run, ...agentCallIdOf(e) } }))
  const reason = spawnLogReason(spawn, e.subagentType, e.model)
  if (spawn.ticket) await logSpawnOnTicket($, spawn.ticket, spawnLogLine(agent.agentId, run, reason))
}

const liveAgentOf = (e: Frozen<AgentSpawnInput>, model: string): LiveAgent => ({
  model,
  description: e.description,
  asked: askedIn(e.prompt),
  ...(e.permissionMode === undefined ? {} : { permissionMode: e.permissionMode }),
})

const countReroute = (spawn: SpawnRoute, model: string): void => {
  if (spawn.isUnrouted) reroutesThisTurn = { count: (reroutesThisTurn?.count ?? 0) + 1, model, category: spawn.route.category }
}

const noteFallback = (e: Frozen<AgentSpawnInput>, spawn: SpawnRoute): void => {
  const reason = fallbackReasonToAnnounce(spawn, e.model)
  if (reason) fallbackReasonsThisTurn.add(reason)
}

// The engine documents CLAUDE_CODE_EFFORT_LEVEL as taking precedence over both a definition's and a call's effort, so
// an effort set beside it is ignored, never an error. Setting one would only make the record claim a level that never ran.
const isEffortSetByEnvironment = async ($: EngineInterface): Promise<boolean> => Boolean(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))

// A workflow script that names a model is taken to have picked the effort too.
const namesItsOwnEffort = (e: Frozen<AgentSpawnInput>): boolean =>
  e.workflow === undefined ? agentCallsNamingEffort.has(e.tool_use_id) : e.model !== undefined

// The tier effort is applied to every model request of an agent this hook routed and whose call named no effort. An
// agent's steps always carry its loop's resolved level, so the step is the one place left to set it.
const takesTierEffort = (e: Frozen<AgentSpawnInput>, spawn: SpawnRoute): boolean => setsModelAndEffort(spawn) && !namesItsOwnEffort(e)

const rememberTierEffort = async ($: EngineInterface, e: Frozen<AgentSpawnInput>, spawn: SpawnRoute, agentId: string) => {
  const effort = effortLevelOf(spawn.route.effort)
  if (!takesTierEffort(e, spawn) || !effort) return
  if (!(await isEffortSetByEnvironment($))) routedAgentEfforts.set(agentId, effort)
}

const noteStartedAgent = async (
  $: EngineInterface,
  e: Frozen<AgentSpawnInput>,
  spawn: SpawnRoute | undefined,
  agent: StartedAgent,
): Promise<void> => {
  await update($, liveAgents, agents => ({ ...agents, [agent.agentId]: liveAgentOf(e, agent.model) }))
  if (!spawn) return
  countReroute(spawn, agent.model)
  noteFallback(e, spawn)
  await rememberTierEffort($, e, spawn, agent.agentId)
  await recordRun($, e, spawn, agent)
}

const spawnShapeOf = (e: Frozen<AgentSpawnInput>): SpawnShape => ({
  subagentType: e.subagentType,
  isEngineProvided: e.provider.plugin === 'engine',
  namesModel: e.model !== undefined,
  isFork: e.fork,
})

const isNewSpawn = (e: Frozen<AgentSpawnInput>): boolean => !e.fork && e.resume === undefined

const withRouteModel = (e: Frozen<AgentSpawnInput>, spawn: SpawnRoute | undefined): Frozen<AgentSpawnInput> =>
  setsModelAndEffort(spawn) && e.model === undefined ? { ...e, model: spawn.route.model } : e

const startedAgentOf = (started: AgentSpawnResult): StartedAgent | undefined =>
  started.deny === undefined && started.agentId !== undefined ? { agentId: started.agentId, model: started.model } : undefined

const routeAgentSpawn: Hook<'agent.spawn'> = async ($, e, next) => {
  const spawn = isNewSpawn(e) ? await routeSpawn($, e, spawnShapeOf(e)) : undefined
  const started = await next(withRouteModel(e, spawn))
  const agent = startedAgentOf(started)
  if (agent) await noteStartedAgent($, e, spawn, agent)
  agentCallsNamingEffort.delete(e.tool_use_id)

  return started
}

// Only notes the call. In auto mode an Agent call whose input a hook changed after the classifier reviewed it is
// refused: 5 of 6 routed agents never started on 2026-11-18 when this hook still added the tier effort.
const noteAgentCallEffort = (call: { tool_use_id: string; effort?: EffortLevel }): void => {
  if (call.effort !== undefined) agentCallsNamingEffort.add(call.tool_use_id)
}

// A reroute is told to the model, which can tag its next spawn. A person cannot act on it, so it is no toast.
const announceReroutes = ($: EngineInterface): void => {
  if (reroutesThisTurn) rememberRerouteLine(rerouteContextLine(reroutesThisTurn.count, reroutesThisTurn.model, reroutesThisTurn.category))
  if (fallbackReasonsThisTurn.size > 0) $.ui.toast(fallbackToast([...fallbackReasonsThisTurn]))
  reroutesThisTurn = undefined
  fallbackReasonsThisTurn.clear()
}

const forgetAgent = async ($: EngineInterface, agentId: string): Promise<void> => {
  routedAgentEfforts.delete(agentId)
  await update($, liveAgents, agents => Object.fromEntries(Object.entries(agents).filter(([id]) => id !== agentId)))
  await forgetPermissionWait($, agentId)
}

// The verdict is the engine's and is handed on untouched. Only a subagent's ask that a person can answer is noted:
// the main loop's own ask is already on screen.
const sensePermissionAsk: Hook<'tool.check'> = async ($, e, next) => {
  const verdict = await next(e)
  const isParkedOnAPerson = e.agentId !== undefined && verdict.decision === 'ask' && e.approver !== undefined
  if (isParkedOnAPerson) await notePermissionWait($, e.agentId, e.tool).catch(() => undefined)

  return verdict
}

const endTurn: Hook<'turn.complete'> = async ($, e, next) => {
  await noteTurnEnd($, e).catch(() => undefined)
  await recordTurnEnd($, e)
  if (e.agentId === undefined) {
    announceReroutes($)
    await warnWhenOutdated($).catch(() => undefined)
  } else await forgetAgent($, e.agentId)

  return next(e)
}

// The summary and routing views name a broken board.json on every read, so the once-a-session line waits for another view.
const boardJsonNoticeForRead = (files: BoardFiles, input: JsonRecord): string | undefined =>
  viewNamesBoardJsonProblems(input) ? undefined : brokenBoardJsonNotice(files)

async function vanishedBoardNotice($: EngineInterface, location: BoardLocation, files: BoardFiles): Promise<string[]> {
  if (wasSaid(VANISHED_BOARD)) return []

  return sayOnce(VANISHED_BOARD, await readVanishedBoardNotice($, location, files).catch(() => undefined))
}

async function firstReadNotices($: EngineInterface, location: BoardLocation, files: BoardFiles, input: JsonRecord): Promise<string[]> {
  return [...sayOnce(BOARD_JSON_ON_READ, boardJsonNoticeForRead(files, input)), ...(await vanishedBoardNotice($, location, files))]
}

const startSession: Hook<'session.start'> = async ($, e, next) => {
  const location = await rememberBoardLocation($, e.cwd)
  forgetNoticesSaid()
  const ids = await readIdsToDescribe($, location).catch(() => EARLIER_BOARD_IDS)
  for (const tool of sidequestToolsOn(ids)) await $.tool.register(tool)
  noteSessionStart(e.isInteractive)
  await update($, permissionWaits, () => ({}))
  await recordReturnsLeftBehind($).catch(() => undefined)
  await rememberRunningPlugin($).catch(() => undefined)
  const tickets = (await readBoard($, location)).tickets
  await publishSummary($, tickets)
  await startBoardViews($, tickets)
  await senseWorktrees($, location).catch(() => undefined)

  return next(e)
}

export const registerCore = (on: On): void => {
  on('session.start', startSession)

  on('tool.call', { tool: 'mcp__sidequest__board' }, async ($, e) => {
    const location = await boardLocation($)
    const files = await readBoard($, location)
    const interrupted = await interruptedWorkOn($, files.tickets).catch(() => NO_INTERRUPTED_WORK)
    const team = await teamFactsForView($, e, files.tickets, interrupted).catch(() => NO_TEAM_FACTS)
    const noAgentHere = new Map([...(await workWithNoAgentHereOn($, files.tickets).catch(() => NO_INTERRUPTED_WORK)), ...interrupted])
    const answer = toolResultOf(answerBoardView(e, files, await stampNow($), interrupted, team, sessionChanges(), noAgentHere))
    // A listing that fails for a moment reads as a board with no tickets, and drawing that would blank the pane and
    // the band. They keep what they had until a write or the pane's own open reads the board again.
    if (files.tickets.length > 0) await showTickets($, files.tickets).catch(() => undefined)

    return withWords(answer, await firstReadNotices($, location, files, e))
  }).catch(($, e, next) => ownToolFailed(causeOf(next.error)))

  on('tool.call', { tool: 'mcp__sidequest__ticket' }, async ($, e) =>
    writeBoard($, async (files, stamp, location) => {
      const prefixFacts = await readPrefixFacts($, location, files).catch(() => undefined)

      return applyTicketOperations(e, files, stamp, sessionTurn(), conflictPairsSaid(), prefixFacts)
    }),
  ).catch(($, e, next) => ownToolFailed(causeOf(next.error)))

  on('tool.call', { tool: 'mcp__sidequest__start' }, async ($, e) => startOnBoard($, e)).catch(($, e, next) => ownToolFailed(causeOf(next.error)))

  on('tool.call', { tool: 'mcp__sidequest__finish' }, async ($, e) => {
    const overlaps = await branchOverlapsForFinish($, e).catch(() => [])

    const existingBranch = await existingBranchForFinish($, e).catch(() => undefined)

    return writeBoard($, (files, stamp) => finishTicket(e, files, stamp, { overlaps, saidPairs: conflictPairsSaid(), existingBranch, touchedThisSession: ticketsTouchedThisSession() }))
  }).catch(($, e, next) => ownToolFailed(causeOf(next.error)))

  on('agent.spawn', routeAgentSpawn).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    noteAgentCallEffort(e)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.check', sensePermissionAsk).catch(($, e, next) => next(e))

  // For the pane only: what the session is doing. Not awaited, so no call waits on it, and its failure never reaches the call.
  on('tool.call', ($, e, next) => {
    void noteToolStart($, e.tool, e, e.agentId).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // A new model request from an agent means the call it asked a permission for has returned.
    if (e.agentId !== undefined && isWaitingOnPermission(e.agentId)) await clearPermissionWait($, e.agentId).catch(() => undefined)
    await noteTurnStep($, e.agentId).catch(() => undefined)
    const effort = e.agentId === undefined ? undefined : routedAgentEfforts.get(e.agentId)

    return yield* next(effort === undefined ? e : { ...e, effort })
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('turn.complete', endTurn).catch(($, e, next) => next(e))
}

export const register: Register = on => {
  registerViews(on)
  registerCore(on)
  registerCompactionLine(on)
  registerReturnRecords(on)
}
