import type { Candidate } from './detectors'
import type { SensedEvent } from './events'

export const TOP_FAILURES = 5
export const TOP_COMMANDS = 10

export type Tally = { name: string; count: number }

export type EvidenceSummary = {
  windowDays: number
  eventCount: number
  candidates: Candidate[]
  skillsExercised: Tally[]
  topFailures: Tally[]
  topDenials: Tally[]
  topCommandsByHand: Tally[]
}

const tally = (names: readonly string[]): Tally[] => {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)

  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

const skillNames = (events: readonly SensedEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'skill' ? [event.skill] : []))

const denialNames = (events: readonly SensedEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'denial' ? [`${event.tool}: ${event.target}`.trim()] : []))

const commandPrefixes = (events: readonly SensedEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'typed' ? [event.prefix] : []))

const failureNames = (events: readonly SensedEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'failure' ? [`${event.tool}: ${event.signature}`.trim()] : []))

/**
 * The bounded aggregate a model may read: counts and the candidates' sentences,
 * never a raw event.
 */
export const summarizeEvidence = (
  events: readonly SensedEvent[],
  candidates: readonly Candidate[],
  windowDays: number,
): EvidenceSummary => ({
  windowDays,
  eventCount: events.length,
  candidates: [...candidates],
  skillsExercised: tally(skillNames(events)),
  topFailures: tally(failureNames(events)).slice(0, TOP_FAILURES),
  topDenials: tally(denialNames(events)).slice(0, TOP_FAILURES),
  topCommandsByHand: tally(commandPrefixes(events)).slice(0, TOP_COMMANDS),
})

export const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const candidateLine = (candidate: Candidate): string => `- ${candidate.fingerprint}: ${candidate.sentence}`

const candidatesText = (summary: EvidenceSummary): string =>
  summary.candidates.length === 0
    ? `No candidates in the last ${summary.windowDays} days (${counted(summary.eventCount, 'event')}).`
    : [
        `${counted(summary.candidates.length, 'candidate')} in the last ${summary.windowDays} days:`,
        ...summary.candidates.map(candidateLine),
      ].join('\n')

const tallyLine = (title: string, tallies: readonly Tally[]): string =>
  `${title}: ${tallies.map(entry => `${entry.name} ${entry.count}`).join(', ') || 'none'}`

const countsHeading = (summary: EvidenceSummary, since?: string): string =>
  since === undefined
    ? `Last ${summary.windowDays} days, ${counted(summary.eventCount, 'event')}.`
    : `Since ${since}, ${counted(summary.eventCount, 'event')}.`

export const evidenceText = (summary: EvidenceSummary, since?: string): string =>
  [
    candidatesText(summary),
    countsHeading(summary, since),
    tallyLine('Skills exercised', summary.skillsExercised),
    tallyLine('Typed by hand', summary.topCommandsByHand),
    tallyLine('Failures', summary.topFailures),
    tallyLine('Denials', summary.topDenials),
  ].join('\n')
