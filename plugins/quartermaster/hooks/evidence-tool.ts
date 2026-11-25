import { EVIDENCE_WINDOW_DAYS, detectCandidates, withoutRejected } from './detectors'
import type { Candidate, SensedHistory } from './detectors'
import type { SensedEvent } from './events'
import { evidenceText, summarizeEvidence } from './evidence'
import { rejectedFingerprints } from './rejections'
import { projectEventsDirectory, readEventsSince, readRejections } from './store'
import type { FileSystem } from './store'

export { EVIDENCE_WINDOW_DAYS }

const DAY_MS = 24 * 60 * 60 * 1000

export type EvidenceSources = {
  files: FileSystem
  cwd: string
  eventsDirectory: string
  pending: readonly SensedEvent[]
  installedSkills: readonly string[]
  now: number
}

export type CurrentEvidence = { history: SensedHistory; candidates: Candidate[] }

export const firstDayOfWindow = (now: number): string => new Date(now - EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)

export const currentEvidence = async (sources: EvidenceSources): Promise<CurrentEvidence> => {
  const stored = await readEventsSince(
    sources.files,
    [sources.eventsDirectory, projectEventsDirectory(sources.cwd)],
    firstDayOfWindow(sources.now),
  )
  const history = { ...stored, events: [...stored.events, ...sources.pending] }
  const rejected = rejectedFingerprints(await readRejections(sources.files, sources.cwd))

  return { history, candidates: withoutRejected(detectCandidates(history, sources.installedSkills, sources.now), rejected) }
}

export type EvidenceAnswer = { deny: string } | { text: string }

const eventsFrom = (events: readonly SensedEvent[], since: number): SensedEvent[] =>
  events.filter(event => Date.parse(event.at) >= since)

/**
 * With `since`, the tallies count only events from that moment on, so a review
 * can compare a change's `expect` count after it landed against its baseline.
 * The candidates always cover the whole window.
 */
export const answerEvidence = async (sources: EvidenceSources, since?: string): Promise<EvidenceAnswer> => {
  const sinceTime = since === undefined ? 0 : Date.parse(since)
  if (Number.isNaN(sinceTime)) return { deny: `quartermaster: since must be an ISO date like 2026-11-01, not ${since}` }
  const { history, candidates } = await currentEvidence(sources)
  const summary = summarizeEvidence(eventsFrom(history.events, sinceTime), candidates, EVIDENCE_WINDOW_DAYS)

  return { text: evidenceText(summary, since) }
}
