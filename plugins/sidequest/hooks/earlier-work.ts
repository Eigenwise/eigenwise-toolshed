import { A_DAY, millisecondsSince } from './ages'

// A waiting ticket this session never touched and that sat a day or more is another piece of work. A younger one is
// likely the same person's other session, so it keeps warning.
export const isFromEarlierWork = (ticketId: string, lastTouchedStamp: string, touchedHere: ReadonlySet<string>, now: number): boolean =>
  !touchedHere.has(ticketId) && millisecondsSince(lastTouchedStamp, now) >= A_DAY
