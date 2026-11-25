import { A_DAY, millisecondsSince } from './ages'
import type { Ticket } from './tickets'

const NOT_STARTED = ['ready', 'inbox']

// `recentlyCreated` is only for a stop with no story in a session that remembers creating nothing: the tickets it may
// have meant, since which ones it created is kept in the module and a resumed or reloaded session has lost it.
export type PlanStop = { planName: string; toPark: Ticket[]; stillRunning: Ticket[]; recentlyCreated?: Ticket[] }

const isInPlan = (ticket: Ticket, storyId: string | undefined, createdThisSession: ReadonlySet<string>): boolean =>
  storyId === undefined ? createdThisSession.has(ticket.id) : ticket.story === storyId

// The created field is a day, so "the last day" counts from the start of yesterday.
const isCreatedInTheLastDay = (ticket: Ticket, now: number): boolean => millisecondsSince(ticket.created, now) < 2 * A_DAY

const recentlyCreatedOf = (tickets: readonly Ticket[], now: number): Ticket[] =>
  tickets.filter(ticket => NOT_STARTED.includes(ticket.status) && isCreatedInTheLastDay(ticket, now))

const remembersNothing = (storyId: string | undefined, createdThisSession: ReadonlySet<string>): boolean =>
  storyId === undefined && createdThisSession.size === 0

// A typed stop ends the plan: what has not started is parked, and running agents finish and report. Without it a
// returning agent picks the stopped plan up again.
export const planStopOf = (
  tickets: readonly Ticket[],
  storyId: string | undefined,
  createdThisSession: ReadonlySet<string>,
  now: number = Number.NaN,
): PlanStop => {
  const plan = tickets.filter(ticket => isInPlan(ticket, storyId, createdThisSession))

  return {
    planName: storyId ?? 'the tickets this session created',
    toPark: plan.filter(ticket => NOT_STARTED.includes(ticket.status)),
    stillRunning: plan.filter(ticket => ticket.status === 'doing'),
    ...(remembersNothing(storyId, createdThisSession) ? { recentlyCreated: recentlyCreatedOf(tickets, now) } : {}),
  }
}

const idsOf = (tickets: readonly Ticket[]): string => tickets.map(ticket => ticket.id).join(', ')

const parkedPart = (stop: PlanStop): string =>
  stop.toPark.length === 0 ? `Nothing in ${stop.planName} was ready or in the inbox, so nothing was parked.` : ''

const runningPart = (stop: PlanStop): string =>
  stop.stillRunning.length === 0 ? 'Nothing in it is running.' : `Still running, left to finish and report: ${idsOf(stop.stillRunning)}.`

const FORGOTTEN =
  'This session does not remember which tickets it created, so nothing was parked: that is lost when a session is resumed or reloaded.'

const maybeMeantPart = (recent: readonly Ticket[]): string =>
  recent.length === 0
    ? 'No ticket created in the last day is ready or in the inbox.'
    : `Created in the last day and ready or in the inbox, so maybe the ones meant: ${recent.map(ticket => `${ticket.id} (${ticket.title})`).join(', ')}. To park them, move each to parked, or call stop with their story.`

export const planStopNote = (stop: PlanStop): string => {
  if (stop.recentlyCreated !== undefined) return `${FORGOTTEN} ${maybeMeantPart(stop.recentlyCreated)}`

  return [parkedPart(stop), runningPart(stop)].filter(part => part !== '').join(' ')
}
