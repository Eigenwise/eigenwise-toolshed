import type { AgentRole, BoardConfig, SharedThing } from './board-config'
import { fallbackCategoryOf, hasRoute } from './routing'
import type { Ticket } from './tickets'

// With worktrees off every worker writes in the one checkout. Two of them there at once mixed each other's work in
// the 2026-11-19 baseline, so the checkout is held like any other shared thing, without being written anywhere.
export const CHECKOUT = 'checkout'

const CHECKOUT_THING: SharedThing = {
  what: 'the main checkout of this repository, where workers write one at a time',
  refresh: 'auto',
}

const runsAs = (ticket: Ticket, config: BoardConfig): AgentRole | undefined => {
  const category = hasRoute(ticket.category, config) ? ticket.category : fallbackCategoryOf(config)

  return category === undefined ? undefined : config.categories[category]?.role
}

const writesInTheCheckout = (ticket: Ticket, config: BoardConfig): boolean =>
  !config.settings.worktrees && runsAs(ticket, config) === 'worker'

export const sharedThingsOf = (config: BoardConfig): Record<string, SharedThing> => ({
  ...(config.settings.worktrees ? {} : { [CHECKOUT]: CHECKOUT_THING }),
  ...config.settings.shared,
})

export const hasSharedThings = (config: BoardConfig): boolean => Object.keys(sharedThingsOf(config)).length > 0

export const thingsUsedBy = (ticket: Ticket, config: BoardConfig): string[] => {
  const written = ticket.uses ?? []

  return writesInTheCheckout(ticket, config) && !written.includes(CHECKOUT) ? [...written, CHECKOUT] : written
}

export const unknownThingsOf = (ticket: Ticket, config: BoardConfig): string[] => {
  const known = sharedThingsOf(config)

  return (ticket.uses ?? []).filter(name => !Object.hasOwn(known, name))
}

export type HeldThing = { thing: string; holder: Ticket }

const holderOf = (thing: string, asking: Ticket, tickets: readonly Ticket[], config: BoardConfig): Ticket | undefined =>
  tickets.find(other => other.id !== asking.id && other.status === 'doing' && thingsUsedBy(other, config).includes(thing))

export const heldThingsFor = (ticket: Ticket, tickets: readonly Ticket[], config: BoardConfig): HeldThing[] =>
  thingsUsedBy(ticket, config).flatMap(thing => {
    const holder = holderOf(thing, ticket, tickets, config)

    return holder === undefined ? [] : [{ thing, holder }]
  })

// A person knows the checkout as the folder they work in.
export const sharedThingWords = (thing: string): string => (thing === CHECKOUT ? 'main project folder' : thing)

const listed = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

const HOW_MANY_IN_USE: Record<number, string> = { 1: 'it', 2: 'both' }

const heldByOneWords = (holderId: string, things: readonly string[]): string =>
  `waits for ${listed(things.map(thing => `the ${sharedThingWords(thing)}`))}, ${holderId} is using ${HOW_MANY_IN_USE[things.length] ?? 'them'}`

type WordsForOneHolder = (holderId: string, things: readonly string[]) => string

// One holder of two things read twice on a pane row and ran past it: each holder is named once with what it holds.
const byHolder = (held: readonly HeldThing[], words: WordsForOneHolder): string => {
  const holderIds = [...new Set(held.map(one => one.holder.id))]

  return holderIds.map(id => words(id, held.filter(one => one.holder.id === id).map(one => one.thing))).join('; ')
}

export const waitsForWords = (held: readonly HeldThing[]): string => byHolder(held, heldByOneWords)

const SHORT_THING_WORDS: Record<string, string> = { [CHECKOUT]: 'project folder' }

const heldByOneShortly = (holderId: string, things: readonly string[]): string =>
  `waits on ${holderId} (${things.map(thing => SHORT_THING_WORDS[thing] ?? thing).join(', ')})`

// A pane row leaves an aside about 44 columns at 60, so the row says it in fewer words than the board tool does.
export const shortWaitsForWords = (held: readonly HeldThing[]): string => byHolder(held, heldByOneShortly)
