import { detectCandidates, withoutRejected } from './detectors'
import type { Candidate } from './detectors'
import type { SensedEvent } from './events'
import { projectSlug } from './events'
import { currentEvidence, firstDayOfWindow } from './evidence-tool'
import type { EvidenceSources } from './evidence-tool'
import { rejectedFingerprints } from './rejections'
import { appendDayEvents, eventsByDay, keepRecordsOutOfGit, projectEventsDirectory, readChangesInTrial, readProposals, readRejections } from './store'
import type { FileSystem, WrittenDayFiles } from './store'
import { TurnBuffer } from './sensing'
import { dueOffersOrNone } from './standing-due'
import type { AppliedChange, Due } from './standing-due'

const WAITING_STATUSES: readonly string[] = ['draft', 'offered']

export const homeEventsDirectory = (home: string, cwd: string): string =>
  `${home}/.claude/quartermaster/events/${projectSlug(cwd)}`

export const eventsDirectoryFor = (home: string | undefined, cwd: string): string =>
  home === undefined || home === '' ? projectEventsDirectory(cwd) : homeEventsDirectory(home, cwd)

/** Impressions sit with the events, outside the project, so offering never writes into someone's repository. */
export const impressionsPathFor = (home: string | undefined, cwd: string): string =>
  `${eventsDirectoryFor(home, cwd)}/impressions.jsonl`

export type Published = { waiting: number; candidates: Candidate[]; due: Due[] }

/**
 * What one session keeps between hooks: the sensed events not yet written,
 * the event window the detectors run over, and where events go. Lost on a
 * reload by design; `load` rebuilds it from the files.
 */
export class SessionMemory {
  readonly buffer = new TurnBuffer()
  private window: SensedEvent[] = []
  private reachesBeforeWindow = false
  private sessionFiles: readonly string[] = []
  private changesInTrial: AppliedChange[] = []
  private rejected = new Set<string>()
  private readonly writtenDayFiles: WrittenDayFiles = new Map()

  constructor(
    readonly files: FileSystem,
    readonly cwd: string,
    readonly eventsDirectory: string,
    readonly installedSkills: readonly string[],
    readonly sessionTag: string,
  ) {}

  sources(now: number): EvidenceSources {
    return {
      files: this.files,
      cwd: this.cwd,
      eventsDirectory: this.eventsDirectory,
      pending: [],
      installedSkills: this.installedSkills,
      now,
    }
  }

  async load(now: number): Promise<Published> {
    const evidence = await currentEvidence(this.sources(now))
    this.window = [...evidence.history.events]
    this.reachesBeforeWindow = evidence.history.reachesBeforeWindow
    this.sessionFiles = evidence.history.sessionFiles ?? []
    this.changesInTrial = await readChangesInTrial(this.files, this.cwd).catch(() => [])
    this.rejected = rejectedFingerprints(await readRejections(this.files, this.cwd))

    return this.published(now)
  }

  async published(now: number): Promise<Published> {
    const { proposals } = await readProposals(this.files, this.cwd)
    const candidates = withoutRejected(detectCandidates(
      { events: this.window, reachesBeforeWindow: this.reachesBeforeWindow },
      this.installedSkills,
      now,
    ), this.rejected)

    const due = dueOffersOrNone({ events: this.window, sessionFiles: this.sessionFiles, candidates, proposals, changes: this.changesInTrial, now })

    return { waiting: proposals.filter(proposal => WAITING_STATUSES.includes(proposal.status)).length, candidates, due }
  }

  async refreshRejections(now: number): Promise<Published> {
    this.rejected = rejectedFingerprints(await readRejections(this.files, this.cwd))

    return this.published(now)
  }

  private async tryWriteDay(day: string, events: readonly SensedEvent[]): Promise<string | undefined> {
    try {
      await appendDayEvents(this.files, this.eventsDirectory, this.sessionTag, day, events, this.writtenDayFiles)

      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** A day's events are tried twice in the events folder, then kept in the project's, so a failure never repeats lines. */
  private async writeDay(day: string, events: readonly SensedEvent[]): Promise<string | undefined> {
    const firstError = await this.tryWriteDay(day, events)
    const error = firstError === undefined ? undefined : await this.tryWriteDay(day, events)
    if (error === undefined) return undefined
    await keepRecordsOutOfGit(this.files, this.cwd)
    await appendDayEvents(this.files, projectEventsDirectory(this.cwd), this.sessionTag, day, events, this.writtenDayFiles)

    return error
  }

  /**
   * One write per day file per turn. Events the events folder refused are kept
   * in the project's `.claude/quartermaster/events/`, which every session reads
   * too, and the first error comes back so it can be said.
   */
  async flush(events: readonly SensedEvent[], now: number): Promise<string | undefined> {
    const firstDay = firstDayOfWindow(now)
    this.window = [...this.window, ...events].filter(event => event.at.slice(0, 10) >= firstDay)
    const errors: string[] = []
    for (const [day, dayEvents] of eventsByDay(events)) {
      const error = await this.writeDay(day, dayEvents)
      if (error !== undefined) errors.push(error)
    }

    return errors[0]
  }
}
