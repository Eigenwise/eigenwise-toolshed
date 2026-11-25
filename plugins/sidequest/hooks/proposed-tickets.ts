import type { Story, Ticket } from './tickets'

// A plan's tickets are filed at its playback under a story marked as waiting for the person's yes. No status says it:
// the mark on the story does, and the yes takes it away, so the tickets are live the moment it does.
export const PLAN_WAITS_FOR_YES = "its plan still waits for the person's yes"

const NOT_STARTED = ['ready', 'inbox']

export const storiesWaitingForYes = (stories: readonly Story[]): ReadonlySet<string> =>
  new Set(stories.filter(story => story.awaitsYes === true).map(story => story.id))

export const isUnderPlanWaitingForYes = (ticket: Ticket, waiting: ReadonlySet<string>): boolean =>
  ticket.story !== undefined && waiting.has(ticket.story)

const isProposed = (ticket: Ticket, waiting: ReadonlySet<string>): boolean =>
  isUnderPlanWaitingForYes(ticket, waiting) && NOT_STARTED.includes(ticket.status)

export const proposedTicketsOf = (story: Story, tickets: readonly Ticket[]): Ticket[] =>
  story.awaitsYes === true ? tickets.filter(ticket => ticket.story === story.id && NOT_STARTED.includes(ticket.status)) : []

// Open work is what can be counted, listed and started: a proposed ticket is none of it until its plan's yes.
export const withoutProposedTickets = (tickets: readonly Ticket[], stories: readonly Story[]): Ticket[] => {
  const waiting = storiesWaitingForYes(stories)

  return waiting.size === 0 ? [...tickets] : tickets.filter(ticket => !isProposed(ticket, waiting))
}

export const proposedTicketsAmong = (tickets: readonly Ticket[], stories: readonly Story[]): Ticket[] => {
  const waiting = storiesWaitingForYes(stories)

  return tickets.filter(ticket => isProposed(ticket, waiting))
}
