import { changeIdFor, parseProposal, proposalNumber, serializeProposal } from './proposals'
import type { Proposal } from './proposals'
import { dayOf, eventLines, parseEventLines } from './events'
import type { SensedEvent } from './events'
import type { SensedHistory } from './detectors'
import { isChangeRecord, planRollback, priorFileName, touchedFiles, withWrittenFiles, writtenFileName } from './changes'
import type { ChangeRecord, FileBytes, RollbackStep, TouchedFile } from './changes'
import { parseRejections, serializeRejections, withRejections } from './rejections'
import type { Rejection } from './rejections'
import { impressionLine, parseImpressions } from './impressions'
import { hasUsableCreated, isInTrial } from './standing-due'
import type { AppliedChange } from './standing-due'
import type { Impression } from './impressions'

export type DirectoryEntry = { name: string; kind: 'file' | 'dir' | 'other' }

/** The slice of `$.fs` the store needs, so tests and logic never touch `$`. */
export type FileSystem = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<DirectoryEntry[]>
}

export const quartermasterDirectory = (cwd: string): string => `${cwd}/.claude/quartermaster`

const legacyImpressionsPath = (cwd: string): string => `${quartermasterDirectory(cwd)}/impressions.jsonl`

export const projectEventsDirectory = (cwd: string): string => `${quartermasterDirectory(cwd)}/events`

const proposalsDirectory = (cwd: string): string => `${quartermasterDirectory(cwd)}/proposals`
const proposalPath = (cwd: string, id: string): string => `${proposalsDirectory(cwd)}/${id}.md`
const rejectedPath = (cwd: string): string => `${quartermasterDirectory(cwd)}/rejected.md`
const changeDirectory = (cwd: string, proposal: string): string =>
  `${quartermasterDirectory(cwd)}/changes/${changeIdFor(proposal)}`

export const readIfPresent = async (files: FileSystem, path: string): Promise<string | undefined> =>
  (await files.exists(path)) ? files.read(path) : undefined

const SELF_IGNORE = `# Quartermaster's records stay personal until a team chooses to share them.\n# Delete this file to commit them.\n*\n`

// Proposals, rejections and the saved bytes of touched files (local settings among them) would ride along on a
// commit, and this folder sits beside files a team does commit. A folder that ignores itself needs no git call.
export const keepRecordsOutOfGit = async (files: FileSystem, cwd: string): Promise<void> => {
  const path = `${quartermasterDirectory(cwd)}/.gitignore`
  if (!(await files.exists(path))) await files.write(path, SELF_IGNORE)
}

const fileNamesIn = async (files: FileSystem, directory: string): Promise<string[]> =>
  (await files.exists(directory))
    ? (await files.list(directory)).filter(entry => entry.kind === 'file').map(entry => entry.name)
    : []

const appendText = async (files: FileSystem, path: string, text: string): Promise<void> =>
  files.write(path, ((await readIfPresent(files, path)) ?? '') + text)

export const eventsByDay = (events: readonly SensedEvent[]): Map<string, SensedEvent[]> => {
  const days = new Map<string, SensedEvent[]>()
  for (const event of events) {
    const day = dayOf(event.at)
    const dayEvents = days.get(day)
    if (dayEvents === undefined) days.set(day, [event])
    else dayEvents.push(event)
  }

  return days
}

/** What this session last wrote to each of its day files: a write adds to it, so nothing is read back. */
export type WrittenDayFiles = Map<string, string>

/** One file per session per day, so two sessions in a project never overwrite each other's lines. */
export const dayFileName = (day: string, session: string): string => `${day}.${session}.jsonl`

export const appendDayEvents = async (
  files: FileSystem,
  directory: string,
  session: string,
  day: string,
  events: readonly SensedEvent[],
  written: WrittenDayFiles,
): Promise<void> => {
  const path = `${directory}/${dayFileName(day, session)}`
  const after = (written.get(path) ?? '') + eventLines(events)
  await files.write(path, after)
  written.set(path, after)
}

const isDayFile = (name: string): boolean => /^\d{4}-\d{2}-\d{2}(\.[a-z0-9]+)?\.jsonl$/.test(name)

const readEventsFrom = async (files: FileSystem, eventsDirectory: string, firstDay: string): Promise<SensedHistory> => {
  const days = (await fileNamesIn(files, eventsDirectory)).filter(isDayFile).sort()
  const inWindow = days.filter(name => name.slice(0, 10) >= firstDay)
  const texts = await Promise.all(inWindow.map(name => files.read(`${eventsDirectory}/${name}`)))

  return { events: texts.flatMap(parseEventLines), reachesBeforeWindow: inWindow.length < days.length, sessionFiles: inWindow }
}

/** Reads every folder given, so events saved to the project when the home folder refused a write are not lost. */
export const readEventsSince = async (
  files: FileSystem,
  eventsDirectories: readonly string[],
  firstDay: string,
): Promise<SensedHistory> => {
  const histories = await Promise.all(
    [...new Set(eventsDirectories)].map(directory => readEventsFrom(files, directory, firstDay)),
  )

  return {
    events: histories.flatMap(history => history.events),
    reachesBeforeWindow: histories.some(history => history.reachesBeforeWindow),
    sessionFiles: histories.flatMap(history => history.sessionFiles ?? []),
  }
}

export type StoredProposals = { proposals: Proposal[]; unreadable: { file: string; problems: string[] }[] }

const readProposalFile = async (files: FileSystem, cwd: string, name: string): Promise<StoredProposals> => {
  const parsed = parseProposal(await files.read(`${proposalsDirectory(cwd)}/${name}`))

  return 'proposal' in parsed
    ? { proposals: [parsed.proposal], unreadable: [] }
    : { proposals: [], unreadable: [{ file: name, problems: parsed.problems }] }
}

export const proposalFileNames = async (files: FileSystem, cwd: string): Promise<string[]> =>
  (await fileNamesIn(files, proposalsDirectory(cwd))).filter(name => proposalNumber(name) !== undefined).sort()

const readAllProposals = async (files: FileSystem, cwd: string): Promise<StoredProposals> => {
  const each = await Promise.all(
    (await proposalFileNames(files, cwd)).map(name => readProposalFile(files, cwd, name)),
  )

  return {
    proposals: each.flatMap(stored => stored.proposals),
    unreadable: each.flatMap(stored => stored.unreadable),
  }
}

let cachedProposals: { cwd: string; stored: StoredProposals } | undefined

/** Called when a session starts and whenever a proposal is written, the only moments the cache could be wrong. */
export const forgetStoredProposals = (): void => {
  cachedProposals = undefined
}

export const readProposals = async (files: FileSystem, cwd: string): Promise<StoredProposals> => {
  if (cachedProposals?.cwd === cwd) return cachedProposals.stored
  const stored = await readAllProposals(files, cwd)
  cachedProposals = { cwd, stored }

  return stored
}

export const readProposal = async (
  files: FileSystem,
  cwd: string,
  id: string,
): Promise<ReturnType<typeof parseProposal> | undefined> => {
  const text = await readIfPresent(files, proposalPath(cwd, id))

  return text === undefined ? undefined : parseProposal(text)
}

export const writeProposal = async (files: FileSystem, cwd: string, proposal: Proposal): Promise<string> => {
  const path = proposalPath(cwd, proposal.id)
  await keepRecordsOutOfGit(files, cwd)
  forgetStoredProposals()
  await files.write(path, serializeProposal(proposal))

  return path
}

export const readRejections = async (files: FileSystem, cwd: string): Promise<Rejection[]> =>
  parseRejections((await readIfPresent(files, rejectedPath(cwd))) ?? '')

export const addRejections = async (files: FileSystem, cwd: string, added: readonly Rejection[]): Promise<void> => {
  await keepRecordsOutOfGit(files, cwd)
  await files.write(rejectedPath(cwd), serializeRejections(withRejections(await readRejections(files, cwd), added)))
}

/** Offers made before impressions moved out of the project are still read, so their backoff holds. */
export const readImpressions = async (files: FileSystem, cwd: string, impressionsPath: string): Promise<Impression[]> => {
  const texts = await Promise.all([legacyImpressionsPath(cwd), impressionsPath].map(path => readIfPresent(files, path)))

  return texts.flatMap(text => parseImpressions(text ?? ''))
}

export const recordImpression = async (
  files: FileSystem,
  cwd: string,
  impressionsPath: string,
  impression: Impression,
): Promise<void> => {
  if (impressionsPath.startsWith(`${quartermasterDirectory(cwd)}/`)) await keepRecordsOutOfGit(files, cwd)
  await appendText(files, impressionsPath, impressionLine(impression))
}

const projectPath = (cwd: string, path: string): string =>
  /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${cwd}/${path}`

/**
 * Saves the bytes of every file before the change touches it. Call it before
 * the first edit: what it saves is what a rollback puts back.
 */
export const snapshotChange = async (
  files: FileSystem,
  cwd: string,
  proposal: string,
  paths: readonly string[],
  created: string,
): Promise<ChangeRecord> => {
  const directory = changeDirectory(cwd, proposal)
  await keepRecordsOutOfGit(files, cwd)
  const priors = await Promise.all(paths.map(path => readIfPresent(files, projectPath(cwd, path))))
  const record: ChangeRecord = {
    id: changeIdFor(proposal),
    proposal,
    created,
    files: touchedFiles(paths, priors.map(prior => prior !== undefined)),
  }
  for (const [index, prior] of priors.entries()) {
    if (prior !== undefined) await files.write(`${directory}/${priorFileName(index)}`, prior)
  }
  await files.write(`${directory}/change.json`, `${JSON.stringify(record, null, 2)}\n`)

  return record
}

export const readChange = async (files: FileSystem, cwd: string, proposal: string): Promise<ChangeRecord | undefined> => {
  const text = await readIfPresent(files, `${changeDirectory(cwd, proposal)}/change.json`)
  const value: unknown = text === undefined ? undefined : JSON.parse(text)

  return isChangeRecord(value) ? value : undefined
}

export const hasChangeRecord = (files: FileSystem, cwd: string, proposal: string): Promise<boolean> =>
  files.exists(`${changeDirectory(cwd, proposal)}/change.json`)

/** The change records of the proposals still on trial: what a review has yet to judge. */
export const readChangesInTrial = async (files: FileSystem, cwd: string): Promise<AppliedChange[]> => {
  const { proposals } = await readProposals(files, cwd)
  const records = await Promise.all(
    proposals.filter(isInTrial).map(async proposal => {
      const record = await readChange(files, cwd, proposal.id).catch(() => undefined)

      return record === undefined || !hasUsableCreated(record.created) ? [] : [{ id: record.id, proposal: proposal.id, kind: proposal.kind, target: proposal.target, created: record.created }]
    }),
  )

  return records.flat()
}

/** `leftAlone` holds one report per file a person changed after the change, which a rollback does not overwrite. */
export type RollbackOutcome = { restored: string[]; toDelete: string[]; leftAlone: string[] }

const savedBytes = async (files: FileSystem, directory: string, name: string | undefined): Promise<string | undefined> =>
  name === undefined ? undefined : files.read(`${directory}/${name}`)

const readFileBytes = async (files: FileSystem, cwd: string, record: ChangeRecord, file: TouchedFile): Promise<FileBytes> => {
  const directory = changeDirectory(cwd, record.proposal)

  return {
    path: file.path,
    existed: file.existed,
    prior: await savedBytes(files, directory, file.prior),
    written: file.after === null ? null : await savedBytes(files, directory, file.after),
    current: await readIfPresent(files, projectPath(cwd, file.path)),
  }
}

const pathsOf = (steps: readonly RollbackStep[], action: RollbackStep['action']): string[] =>
  steps.filter(step => step.action === action).map(step => step.path)

/**
 * `$.fs` can write but not delete, so files the change created come back in
 * `toDelete` for the session to remove. A file that no longer holds what the
 * change wrote is never written or listed for deletion.
 */
export const applyRollback = async (files: FileSystem, cwd: string, record: ChangeRecord): Promise<RollbackOutcome> => {
  const steps = planRollback(await Promise.all(record.files.map(file => readFileBytes(files, cwd, record, file))))
  for (const step of steps) {
    if (step.action === 'restore') await files.write(projectPath(cwd, step.path), step.prior)
  }

  return {
    restored: pathsOf(steps, 'restore'),
    toDelete: pathsOf(steps, 'delete'),
    leftAlone: steps.flatMap(step => (step.action === 'leave' ? [step.report] : [])),
  }
}

const saveWrittenFiles = async (files: FileSystem, cwd: string, record: ChangeRecord): Promise<void> => {
  const directory = changeDirectory(cwd, record.proposal)
  const current = await Promise.all(record.files.map(file => readIfPresent(files, projectPath(cwd, file.path))))
  for (const [index, bytes] of current.entries()) {
    if (bytes !== undefined && record.files[index]?.after === undefined) {
      await files.write(`${directory}/${writtenFileName(index)}`, bytes)
    }
  }
  await files.write(`${directory}/change.json`, `${JSON.stringify(withWrittenFiles(record, current), null, 2)}
`)
}

/**
 * Call it once the change is made: what each file holds then is what a later
 * rollback expects to find, so an edit made after it is never written over.
 */
export const recordWrittenFiles = async (files: FileSystem, cwd: string, proposal: string): Promise<void> => {
  const record = await readChange(files, cwd, proposal)
  if (record !== undefined) await saveWrittenFiles(files, cwd, record)
}
