import type { Ticket } from './tickets'

// Seen in two real first sessions: a board of done and parked tickets with one in the inbox got the long line, and a
// read-only lookup then read the board and loaded the front door. Nothing starts an inbox ticket unasked, so it is
// not work in flight.
const STATUSES_WITH_NO_WORK_IN_FLIGHT = ['done', 'parked', 'dropped', 'inbox']

const OPEN_BOARD_LINE =
  'Sidequest: this project has a board with open tickets. They record earlier work and are not a request: do what the person asks. When that is work on the board (a ticket they name, or carrying on with it), load the sidequest:sidequest skill first, plan, call mcp__sidequest__start for each ticket they asked for, and let the routed agents do the building. For any other request to change, fix, build or look into something, load the sidequest:sidequest skill first and plan before doing the work.'

export const EMPTY_BOARD_LINE =
  'Sidequest: for a request to change, fix, build or look into something, load the sidequest:sidequest skill first and say your plan before the first edit. A small change too. Only reading back what is already there (a file, a log, an earlier session) needs neither.'

export const firstPromptLine = (tickets: readonly Ticket[]): string =>
  tickets.some(ticket => !STATUSES_WITH_NO_WORK_IN_FLIGHT.includes(ticket.status)) ? OPEN_BOARD_LINE : EMPTY_BOARD_LINE
