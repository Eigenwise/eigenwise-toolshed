import { atom, read } from 'claude-code'
import type { EngineInterface, Frozen, On, TurnCompleteInput } from 'claude-code'

import { isReturnedNotRecorded, recordedByBoard, withReturnRecord } from './agent-returns'
import type { BoardRecording } from './agent-returns'
import { boardLocation, publishSummary, queueBoardWrite } from './board-session'
import { noteTurnStart } from './register-session-work'
import { writeBoardDecision } from './store'
import type { BoardChange } from './store'
import { minuteStamp, withChangedTickets } from './tickets'
import type { Ticket } from './tickets'
import { showBoardOwnWrite } from './views/register-views'
import type { FinishedRun } from './views/board-view'

// The host only follows a state name declared in the file that uses it, so this file names its own.
const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })

// Kept in the module, not on the board: the ticket file alone says a return is not recorded, and these only time
// the repair. The first main turn that starts after a return is the session's chance to call finish; at its end the
// board records what is still missing. A fresh module (a reload, an enable, a worker respawn) starts with both
// empty, and its session.start records every return left on the board at once, a just-returned one included, as
// does a second session opening on the same project. A finish after that still appends and moves the ticket again.
const returnsAwaitingAMainTurn = new Set<string>()
const returnsGivenAMainTurn = new Set<string>()

type TicketRewrite = { tickets: Ticket[]; finished: FinishedRun[] }

const rewriteDecision = (rewrite: TicketRewrite): { rewrite: TicketRewrite; change?: BoardChange } =>
  rewrite.tickets.length === 0 ? { rewrite } : { rewrite, change: { tickets: rewrite.tickets, stories: [] } }

function rewriteTickets($: EngineInterface, rewrite: (tickets: readonly Ticket[], stamp: string) => TicketRewrite): Promise<void> {
  return queueBoardWrite(async () => {
    const stamp = minuteStamp(await $.clock.now())
    const written = await writeBoardDecision($, await boardLocation($), files => rewriteDecision(rewrite(files.tickets, stamp)))
    if (written.saved.tickets.length === 0) return
    const after = withChangedTickets(written.files.tickets, written.saved.tickets)
    await publishSummary($, after)
    await showBoardOwnWrite($, after, written.decision.rewrite.finished)
  })
}

// A stop that adds nothing hands the same ticket back, and it is not written again.
const changedRecord = (before: Ticket, after: Ticket): Ticket[] => (after === before ? [] : [after])

async function recordAgentReturn($: EngineInterface, agentId: string, e: Frozen<TurnCompleteInput>): Promise<void> {
  const run = (await read($, agentRuns))[agentId]
  const ticketId = run?.ticket
  if (run === undefined || ticketId === undefined) return
  const agentReturn = { category: run.category, ending: e.reason, durationMs: e.durationMs, answer: e.answer, agentId }
  await rewriteTickets($, (tickets, stamp) => ({
    tickets: tickets.filter(ticket => ticket.id === ticketId).flatMap(ticket => changedRecord(ticket, withReturnRecord(ticket, stamp, agentReturn))),
    finished: [],
  }))
  returnsAwaitingAMainTurn.add(ticketId)
}

const giveReturnsAMainTurn = (): void => {
  for (const ticketId of returnsAwaitingAMainTurn) returnsGivenAMainTurn.add(ticketId)
  returnsAwaitingAMainTurn.clear()
}

// A follow-up message wakes a returned worker under its old id, and the spawn hook lists it live again, so a ticket
// whose run is alive is never recorded under it.
async function ticketsWithALiveAgent($: EngineInterface): Promise<Set<string>> {
  const [agents, runs] = await Promise.all([read($, liveAgents), read($, agentRuns)])

  return new Set(Object.keys(agents).flatMap(agentId => runs[agentId]?.ticket ?? []))
}

const finishedRunOf = (recording: BoardRecording): FinishedRun => ({ id: recording.ticket.id, outcome: recording.outcome })

async function recordWhatNobodyFinished($: EngineInterface, isDue: (ticketId: string) => boolean): Promise<void> {
  const running = await ticketsWithALiveAgent($)
  const isRecordable = (ticket: Ticket): boolean => isDue(ticket.id) && !running.has(ticket.id) && isReturnedNotRecorded(ticket)

  return rewriteTickets($, (tickets, stamp) => {
    const recordings = tickets.filter(isRecordable).map(ticket => recordedByBoard(ticket, stamp))

    return { tickets: recordings.map(recording => recording.ticket), finished: recordings.map(finishedRunOf) }
  })
}

async function recordAfterMainTurn($: EngineInterface): Promise<void> {
  if (returnsGivenAMainTurn.size === 0) return
  const due = new Set(returnsGivenAMainTurn)
  returnsGivenAMainTurn.clear()
  await recordWhatNobodyFinished($, ticketId => due.has(ticketId))
}

export function recordReturnsLeftBehind($: EngineInterface): Promise<void> {
  return recordWhatNobodyFinished($, () => true)
}

// Called from the module's one turn.complete hook. Recording never stands in the way of the turn ending: a failure
// leaves the ticket as it was, and the next repair or the session reads it from the file again.
export async function recordTurnEnd($: EngineInterface, e: Frozen<TurnCompleteInput>): Promise<void> {
  if (e.agentId === undefined) await recordAfterMainTurn($).catch(() => undefined)
  else await recordAgentReturn($, e.agentId, e).catch(() => undefined)
}

export const registerReturnRecords = (on: On): void => {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) giveReturnsAMainTurn()
    await noteTurnStart($, e.agentId).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))
}
