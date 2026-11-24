import type { IdsOnBoard } from './board-ids'
import { STARTED_BY_SESSION, TICKET_KINDS, TICKET_MODES, TICKET_STATUSES } from './tickets'
import type { Ticket, TicketPatch } from './tickets'

const REPAIRED_TEXT_FIELDS = ['status', 'kind', 'mode', 'story', 'startedBy'] as const
type RepairedTextField = (typeof REPAIRED_TEXT_FIELDS)[number]

type TextFieldRule = { accepts: string; read: (value: string) => string | undefined }

export type RepairedPatch = { patch: TicketPatch; notes: string[] }

const oneOf = (allowed: readonly string[]): TextFieldRule => ({
  accepts: allowed.join(', '),
  read: value => {
    const plain = value.trim().toLowerCase()

    return allowed.includes(plain) ? plain : undefined
  },
})

// An empty value is how a patch removes an optional field, so it is always taken.
const optionalStoryRule = (ids: IdsOnBoard): TextFieldRule => ({
  accepts: `a story id like ${ids.storyExample}, or an empty string to remove it`,
  read: value => {
    const plain = value.trim().toUpperCase()

    return plain === '' || ids.isStoryId(plain) ? plain : undefined
  },
})

// Seen 2026-11-19: "session (side work)". Whatever follows the word, the session opened the work.
const startedByRule: TextFieldRule = {
  accepts: `${STARTED_BY_SESSION}, or leave it out when the person asked for the work`,
  read: value => {
    const plain = value.trim().toLowerCase()
    if (plain === '') return ''

    return plain.startsWith(STARTED_BY_SESSION) ? STARTED_BY_SESSION : undefined
  },
}

const textFieldRules = (ids: IdsOnBoard): Record<RepairedTextField, TextFieldRule> => ({
  status: oneOf(TICKET_STATUSES),
  kind: oneOf(TICKET_KINDS),
  mode: oneOf(TICKET_MODES),
  story: optionalStoryRule(ids),
  startedBy: startedByRule,
})

const withoutField = (patch: TicketPatch, field: RepairedTextField | 'blockedBy'): TicketPatch => {
  const kept = { ...patch }
  delete kept[field]

  return kept
}

const withTextField = (patch: TicketPatch, field: RepairedTextField, value: string): TicketPatch => {
  const changed = { ...patch }
  changed[field] = value

  return changed
}

const keptValueWords = (ticket: Ticket, field: RepairedTextField): string => {
  const kept = ticket[field]

  return kept === undefined || kept === '' ? `${field} is left out` : `${field} stays ${kept}`
}

const repairTextField = (ticket: Ticket, patch: TicketPatch, field: RepairedTextField, rules: Record<RepairedTextField, TextFieldRule>): RepairedPatch => {
  const given = patch[field]
  if (given === undefined) return { patch, notes: [] }
  const rule = rules[field]
  const taken = rule.read(given)
  if (taken === given) return { patch, notes: [] }
  if (taken !== undefined) return { patch: withTextField(patch, field, taken), notes: [`${ticket.id}: ${field} "${given}" was read as "${taken}".`] }

  return {
    patch: withoutField(patch, field),
    notes: [`${ticket.id}: ${field} "${given}" was not taken, so ${keptValueWords(ticket, field)}. ${field} takes ${rule.accepts}.`],
  }
}

const listWords = (ids: readonly string[]): string => `[${ids.join(', ')}]`

const repairBlockedBy = (ticket: Ticket, patch: TicketPatch, ids: IdsOnBoard): RepairedPatch => {
  const given = patch.blockedBy
  if (given === undefined) return { patch, notes: [] }
  const taken = given.map(id => id.trim().toUpperCase())
  if (!taken.every(ids.isTicketId)) {
    const kept = `so blockedBy stays ${listWords(ticket.blockedBy)}. blockedBy takes ticket ids like ${ids.ticketExample}.`

    return { patch: withoutField(patch, 'blockedBy'), notes: [`${ticket.id}: blockedBy ${listWords(given)} was not taken, ${kept}`] }
  }
  const isUnchanged = taken.every((id, index) => id === given[index])

  return isUnchanged
    ? { patch, notes: [] }
    : { patch: { ...patch, blockedBy: taken }, notes: [`${ticket.id}: blockedBy ${listWords(given)} was read as ${listWords(taken)}.`] }
}

// A slip in one field is bookkeeping: it is read where the meaning is plain, else that one field keeps what the
// ticket had, and the rest of the write lands. ticket is what the patch goes onto: the board's copy, or a new ticket's
// defaults.
export const repairedTicketPatch = (ticket: Ticket, patch: TicketPatch, ids: IdsOnBoard): RepairedPatch => {
  const rules = textFieldRules(ids)

  return REPAIRED_TEXT_FIELDS.reduce<RepairedPatch>((repaired, field) => {
    const next = repairTextField(ticket, repaired.patch, field, rules)

    return { patch: next.patch, notes: [...repaired.notes, ...next.notes] }
  }, repairBlockedBy(ticket, patch, ids))
}
