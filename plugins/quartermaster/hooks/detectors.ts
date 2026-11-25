import { dayOf, failureLabel, repeatsAnError } from './events'
import type { SensedEvent } from './events'
import type { QuartermasterCandidate, QuartermasterCandidateKind } from '../types'

export const REPEATED_COMMAND_RUNS = 8
export const REPEATED_COMMAND_DAYS = 2
export const REPEATED_FAILURES = 5
export const REPEATED_FAILURE_DAYS = 2
export const REPEATED_DENIALS = 4
export const STILL_HAPPENING_DAYS = 7
export const UNUSED_SKILL_DAYS = 30

// A skill is judged unused over everything the evidence read reaches, so the two are one number.
export const EVIDENCE_WINDOW_DAYS = UNUSED_SKILL_DAYS

const DAY_MS = 24 * 60 * 60 * 1000

export type CandidateKind = QuartermasterCandidateKind
export type Candidate = QuartermasterCandidate

/** A fingerprint is a proposal evidence item, so it never holds a comma or a bracket. */
export const fingerprintOf = (kind: string, target: string): string =>
  `${kind}:${target.trim().toLowerCase().replace(/[,[\]]/g, '').replace(/\s+/g, ' ')}`

type Sighting = { target: string; at: string }

type Group = { target: string; sightings: Sighting[] }

const groupByTarget = (sightings: readonly Sighting[]): Group[] => {
  const groups = new Map<string, Sighting[]>()
  for (const sighting of sightings) {
    const grouped = groups.get(sighting.target)
    if (grouped === undefined) groups.set(sighting.target, [sighting])
    else grouped.push(sighting)
  }

  return [...groups].map(([target, grouped]) => ({ target, sightings: grouped }))
}

const timesOf = (group: Group): string[] => group.sightings.map(sighting => sighting.at).sort()

const distinctDays = (group: Group): number => new Set(group.sightings.map(sighting => dayOf(sighting.at))).size

const candidateFrom = (kind: CandidateKind, group: Group, sentence: string): Candidate => {
  const times = timesOf(group)

  return {
    fingerprint: fingerprintOf(kind, group.target),
    kind,
    target: group.target,
    count: times.length,
    firstSeen: times[0] ?? '',
    lastSeen: times[times.length - 1] ?? '',
    sentence,
  }
}

const commandSightings = (events: readonly SensedEvent[]): Sighting[] =>
  events.flatMap(event => (event.kind === 'typed' ? [{ target: event.prefix, at: event.at }] : []))

// A fix is offered for an error text that comes back, never for a command name that only fails now and then for other reasons.
const failureSightings = (events: readonly SensedEvent[]): Sighting[] =>
  events.flatMap(event =>
    event.kind === 'failure' && repeatsAnError(event) ? [{ target: failureLabel(event), at: event.at }] : [],
  )

const denialSightings = (events: readonly SensedEvent[]): Sighting[] =>
  events.flatMap(event => (event.kind === 'denial' ? [{ target: `${event.tool}: ${event.target}`, at: event.at }] : []))

const isRepeatedCommand = (group: Group): boolean =>
  group.sightings.length >= REPEATED_COMMAND_RUNS && distinctDays(group) >= REPEATED_COMMAND_DAYS

export const repeatedCommands = (events: readonly SensedEvent[]): Candidate[] =>
  groupByTarget(commandSightings(events))
    .filter(isRepeatedCommand)
    .map(group =>
      candidateFrom(
        'script',
        group,
        `ran \`${group.target}\` by hand ${group.sightings.length} times over ${distinctDays(group)} days`,
      ),
    )

// A connector's tool arrives as `mcp__plugin_<plugin>_<server>__<tool>`: a person knows it as the server and the tool.
const CONNECTOR_TOOL = /^mcp__(?:plugin_[^_]+_)?(.+?)__/

export const withPlainToolName = (target: string): string => target.replace(CONNECTOR_TOOL, '$1 ')

// One burst of the same mistake in a single sitting is one mistake: a failure counts as recurring when it comes back on another day.
const isRecurringFailure = (group: Group): boolean =>
  group.sightings.length >= REPEATED_FAILURES && distinctDays(group) >= REPEATED_FAILURE_DAYS

export const repeatedFailures = (events: readonly SensedEvent[]): Candidate[] =>
  groupByTarget(failureSightings(events))
    .filter(isRecurringFailure)
    .map(group =>
      candidateFrom(
        'fix',
        group,
        `${withPlainToolName(group.target)} failed ${group.sightings.length} times over ${distinctDays(group)} days`,
      ),
    )

// A denial of a tool that is no shell command records the tool as its own target, which would say the name twice.
const deniedThing = (target: string): string => {
  const [tool = '', ...rest] = target.split(': ')
  const what = rest.join(': ')

  return `\`${withPlainToolName(what === '' || what === tool ? tool : what)}\``
}

export const repeatedDenials = (events: readonly SensedEvent[]): Candidate[] =>
  groupByTarget(denialSightings(events))
    .filter(group => group.sightings.length >= REPEATED_DENIALS)
    .map(group => candidateFrom('permission', group, `Claude tried ${deniedThing(group.target)} ${group.sightings.length} times and was blocked each time`))

/**
 * The events in the window, and whether any day file is older than it: only
 * then has the human had the whole window to use a skill. `sessionFiles` are
 * the names of the day files read, one per session per day, so sessions are
 * counted without reading their events again.
 */
export type SensedHistory = {
  events: readonly SensedEvent[]
  reachesBeforeWindow: boolean
  sessionFiles?: readonly string[]
}

const exercisedSkillsSince = (events: readonly SensedEvent[], since: number): Set<string> =>
  new Set(events.flatMap(event => (event.kind === 'skill' && Date.parse(event.at) >= since ? [event.skill] : [])))

const unusedSkillCandidate = (skill: string, windowStart: string, now: string): Candidate => ({
  fingerprint: fingerprintOf('retire', skill),
  kind: 'retire',
  target: skill,
  count: 0,
  firstSeen: windowStart,
  lastSeen: now,
  sentence: `\`${skill}\` was installed and never used in ${UNUSED_SKILL_DAYS} days`,
})

/**
 * A fresh install has not had the chance to use anything yet, and a window
 * with no skill use at all more likely means skill sensing is switched off
 * than that every skill went unused, so neither is judged.
 */
export const unusedSkills = (history: SensedHistory, installedSkills: readonly string[], now: number): Candidate[] => {
  const windowStart = now - UNUSED_SKILL_DAYS * DAY_MS
  const exercised = exercisedSkillsSince(history.events, windowStart)
  if (!history.reachesBeforeWindow || exercised.size === 0) return []

  return installedSkills
    .filter(skill => !exercised.has(skill))
    .map(skill => unusedSkillCandidate(skill, new Date(windowStart).toISOString(), new Date(now).toISOString()))
}

// What stopped going wrong leaves by itself, so nobody has to dismiss last week's trouble by hand.
const isStillHappening = (candidate: Candidate, now: number): boolean =>
  now - Date.parse(candidate.lastSeen) <= STILL_HAPPENING_DAYS * DAY_MS

export const detectCandidates = (
  history: SensedHistory,
  installedSkills: readonly string[],
  now: number,
): Candidate[] => [
  ...repeatedCommands(history.events),
  ...repeatedFailures(history.events).filter(candidate => isStillHappening(candidate, now)),
  ...repeatedDenials(history.events).filter(candidate => isStillHappening(candidate, now)),
  ...unusedSkills(history, installedSkills, now),
]

export const withoutRejected = (candidates: readonly Candidate[], rejected: ReadonlySet<string>): Candidate[] =>
  candidates.filter(candidate => !rejected.has(candidate.fingerprint))
