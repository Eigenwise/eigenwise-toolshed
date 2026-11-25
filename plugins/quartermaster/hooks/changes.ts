import { hasStringFields, isJsonObject } from './tool-input'

/**
 * `after` names the file holding the bytes the change left. `null` means the
 * change left no file there. Missing means the record was made before the
 * written bytes were saved, so nothing is known about what the change wrote.
 */
export type TouchedFile = {
  path: string
  existed: boolean
  prior?: string
  after?: string | null
}

export type ChangeRecord = {
  id: string
  proposal: string
  created: string
  files: TouchedFile[]
}

/** The three versions of one file a rollback weighs. For `written`, missing means not recorded and `null` means no file. */
export type FileBytes = {
  path: string
  existed: boolean
  prior?: string
  written?: string | null
  current?: string
}

export type RollbackStep =
  | { action: 'restore'; path: string; prior: string }
  | { action: 'delete'; path: string }
  | { action: 'already-undone'; path: string }
  | { action: 'leave'; path: string; report: string }

const SHOWN_LINE_LIMIT = 20

export const priorFileName = (index: number): string => `prior/${index}.txt`

export const writtenFileName = (index: number): string => `after/${index}.txt`

export const touchedFiles = (paths: readonly string[], existing: readonly boolean[]): TouchedFile[] =>
  paths.map((path, index) =>
    existing[index] === true ? { path, existed: true, prior: priorFileName(index) } : { path, existed: false },
  )

/** Notes what each file holds once the change is made; a file already noted keeps its note. */
export const withWrittenFiles = (record: ChangeRecord, current: readonly (string | undefined)[]): ChangeRecord => ({
  ...record,
  files: record.files.map((file, index) =>
    file.after !== undefined ? file : { ...file, after: current[index] === undefined ? null : writtenFileName(index) },
  ),
})

const bytesBeforeChange = (file: FileBytes): string | undefined => (file.existed ? file.prior : undefined)

const isAsTheChangeLeftIt = (file: FileBytes): boolean =>
  file.written !== undefined && file.current === (file.written ?? undefined)

const rollbackAction = (file: FileBytes): 'restore' | 'delete' | 'already-undone' | 'changed' => {
  if (file.current === bytesBeforeChange(file)) return 'already-undone'
  if (!isAsTheChangeLeftIt(file)) return 'changed'

  return file.existed ? 'restore' : 'delete'
}

const linesOf = (text: string): string[] => text.split('\n').filter(line => line.trim() !== '')

const unmatchedLines = (lines: readonly string[], others: readonly string[]): string[] => {
  const remaining = [...others]

  return lines.filter(line => {
    const matchIndex = remaining.indexOf(line)
    if (matchIndex !== -1) remaining.splice(matchIndex, 1)

    return matchIndex === -1
  })
}

/** Lines only `from` has come first, marked `-`, then lines only `to` has, marked `+`. Order within a file is not kept. */
const lineDifference = (from: string, to: string): string[] => {
  const fromLines = linesOf(from)
  const toLines = linesOf(to)

  return [
    ...unmatchedLines(fromLines, toLines).map(line => `- ${line}`),
    ...unmatchedLines(toLines, fromLines).map(line => `+ ${line}`),
  ]
}

const cappedLines = (lines: readonly string[]): string[] =>
  lines.length <= SHOWN_LINE_LIMIT
    ? [...lines]
    : [...lines.slice(0, SHOWN_LINE_LIMIT), `... ${lines.length - SHOWN_LINE_LIMIT} more lines`]

const changedReport = (file: FileBytes): string =>
  [
    `${file.path} changed since the change was applied, so it was left alone.`,
    'Since then (- what the change wrote, + what the file holds now):',
    ...cappedLines(lineDifference(file.written ?? '', file.current ?? '')),
    'To undo the change by hand (- it removed, + it added):',
    ...cappedLines(lineDifference(file.prior ?? '', file.written ?? '')),
  ].join('\n')

const unknownReport = (file: FileBytes): string =>
  `${file.path} was left alone: this change was made before Quartermaster saved what a change wrote, so it cannot tell whether the file changed since. Compare it with the saved prior bytes by hand.`

const leftAloneReport = (file: FileBytes): string => (file.written === undefined ? unknownReport(file) : changedReport(file))

const stepFor = (file: FileBytes): RollbackStep => {
  const action = rollbackAction(file)
  if (action === 'restore') return { action, path: file.path, prior: file.prior ?? '' }
  if (action === 'changed') return { action: 'leave', path: file.path, report: leftAloneReport(file) }

  return { action, path: file.path }
}

/**
 * Undoes a change file by file, only where the file still holds what the
 * change wrote: what existed gets its prior bytes back, what the change
 * created goes away, and anything edited since is left for a person.
 */
export const planRollback = (files: readonly FileBytes[]): RollbackStep[] => files.map(stepFor)

const isTouchedFile = (value: unknown): value is TouchedFile =>
  isJsonObject(value) && hasStringFields(value, ['path']) && typeof value.existed === 'boolean'

export const isChangeRecord = (value: unknown): value is ChangeRecord =>
  isJsonObject(value) &&
  hasStringFields(value, ['id', 'proposal']) &&
  Array.isArray(value.files) &&
  value.files.every(isTouchedFile)
