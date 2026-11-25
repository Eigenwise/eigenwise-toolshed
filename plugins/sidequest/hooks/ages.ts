import type { Ticket } from './tickets'

// Ages come from the ticket's own stamps, never from file times, which a checkout or a sync resets.

export const A_DAY = 24 * 60 * 60 * 1000
export const A_WEEK = 7 * A_DAY

// The newest log line's stamp, else the day the ticket was last written.
export const lastTouchedOf = (ticket: Ticket): string => ticket.log.at(-1)?.split(' ')[0] ?? ticket.updated

// NaN when the stamp does not parse, so every comparison with it is false and nothing claims an age it cannot know.
export const millisecondsSince = (stamp: string, now: number): number => now - Date.parse(stamp)

export const daysWords = (milliseconds: number): string => {
  const days = Math.floor(milliseconds / A_DAY)

  return days === 1 ? '1 day' : `${days} days`
}

export const oldestAge = (stamps: readonly string[], now: number): number =>
  Math.max(...stamps.map(stamp => millisecondsSince(stamp, now)).filter(Number.isFinite))
