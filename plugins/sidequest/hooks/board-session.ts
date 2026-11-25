import type { EngineInterface } from 'claude-code'

import type { ChatEnding } from './chat-ending'
import { mayBeBareRepository, withBareRepositoryRoot } from './board-root'
import { ticketsTouchedThisSession } from './register-closing-report'
import { withoutProposedTickets } from './proposed-tickets'
import { locateBoard, readOptionalText, readStoriesAndCheckout } from './store'
import type { BoardLocation } from './store'
import { summarize } from './summary'
import type { Story, Ticket } from './tickets'

const SUMMARY = { plugin: 'sidequest', key: 'summary' } as const

async function storiesNow($: EngineInterface): Promise<readonly Story[]> {
  const read = await readStoriesAndCheckout($, await boardLocation($)).catch(() => undefined)

  return read?.stories ?? []
}

// The band counts open work, and a plan's proposed tickets are none until its yes.
export async function publishSummary($: EngineInterface, tickets: readonly Ticket[], stories?: readonly Story[]): Promise<void> {
  const openWork = withoutProposedTickets(tickets, stories ?? (await storiesNow($)))
  await $.state.set(SUMMARY, summarize(openWork, ticketsTouchedThisSession(), await $.clock.now()))
}

// Every board write is a read-modify-write, and the model batches tool calls, so writes run one at a time or two creates both take the same id.
let boardWrites: Promise<unknown> = Promise.resolve()

export function queueBoardWrite<Result>(write: () => Promise<Result>): Promise<Result> {
  const queued = boardWrites.then(write)
  boardWrites = queued.catch(() => undefined)

  return queued
}

// Resolved once per module load: session.start sets it, and a reload that skips session.start resolves it on first use.
let knownBoardLocation: Promise<BoardLocation> | undefined
// The folder the board was found from, so a create can tell a session that moved into another project.
let folderBoardWasFoundFrom: string | undefined

async function withBareRoot($: EngineInterface, location: BoardLocation): Promise<BoardLocation> {
  if (!mayBeBareRepository(location)) return location

  return withBareRepositoryRoot(location, await readOptionalText($, `${location.gitCommonDir}/config`))
}

// A shell cd moves the working folder and the root stays, so the root is where the board lives.
async function boardHomeFolder($: EngineInterface, workingFolder: string): Promise<string> {
  return (await $.session.root().catch(() => undefined)) ?? workingFolder
}

export async function rememberBoardLocation($: EngineInterface, workingFolder: string): Promise<BoardLocation> {
  const home = await boardHomeFolder($, workingFolder)
  folderBoardWasFoundFrom = home
  knownBoardLocation = locateBoard($, home).then(location => withBareRoot($, location))

  return knownBoardLocation
}

export function boardLocation($: EngineInterface): Promise<BoardLocation> {
  return knownBoardLocation ?? $.session.cwd().then(workingFolder => rememberBoardLocation($, workingFolder))
}

export const boardFoundFrom = (): string | undefined => folderBoardWasFoundFrom

// A write hands the board as it left it to the drawing that follows, so a start reads the board once and not twice.
// Taken once: a drawing with nothing handed to it reads the board itself.
let ticketsAfterLastWrite: readonly Ticket[] | undefined

export function handOnTicketsAfterWrite(tickets: readonly Ticket[]): void {
  ticketsAfterLastWrite = tickets
}

export function takeTicketsAfterWrite(): readonly Ticket[] | undefined {
  const tickets = ticketsAfterLastWrite
  ticketsAfterLastWrite = undefined

  return tickets
}

// A write at a stop where the person reads and decides names what to show to the drawing that follows: the plan, with
// the proposed tickets a correction changed, or the ticket whose commit question it filled in.
export type ViewAfterWrite = { story: string; changedProposed: readonly string[] } | { ticket: string }

let viewToShowAfterWrite: ViewAfterWrite | undefined

export function handOnViewToShow(view: ViewAfterWrite | undefined): void {
  viewToShowAfterWrite = view
}

export function takeViewToShow(): ViewAfterWrite | undefined {
  const view = viewToShowAfterWrite
  viewToShowAfterWrite = undefined

  return view
}

// A write that gave a story its first path names it to the drawing that follows, which places that path once in the
// transcript.
let pathToPlaceAfterWrite: string | undefined

export function handOnPathToPlace(id: string | undefined): void {
  pathToPlaceAfterWrite = id
}

export function takePathToPlace(): string | undefined {
  const id = pathToPlaceAfterWrite
  pathToPlaceAfterWrite = undefined

  return id
}

// A write at a stop where the person decides hands what to say in the chat to the drawing that follows, which knows
// whether the board shows it.
let chatEndingOfLastWrite: ChatEnding | undefined

export function handOnChatEnding(chat: ChatEnding | undefined): void {
  chatEndingOfLastWrite = chat
}

export function takeChatEnding(): ChatEnding | undefined {
  const chat = chatEndingOfLastWrite
  chatEndingOfLastWrite = undefined

  return chat
}
