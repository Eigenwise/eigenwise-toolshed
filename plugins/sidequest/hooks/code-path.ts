import type { Excerpt, PathStep } from '../types'

export const PATH_HEADING = 'Path'
export const EXCERPTS_HEADING = 'Excerpts'

const FENCE = '```'

const CHANGED = '[changed]'

const stepLine = (step: PathStep, index: number): string =>
  [`${index + 1}. ${step.what} (${step.file}:${step.line})`, step.changed ? CHANGED : '', step.note].filter(part => part !== '').join(' ')

export const pathSection = (path: readonly PathStep[]): string => path.map(stepLine).join('\n')

const STEP_LINE = /^\d+\.\s+(.*?)\s+\(([^()]+):(\d+)\)\s*(\[changed\])?\s*(.*)$/

const stepFrom = (line: string): PathStep[] => {
  const match = STEP_LINE.exec(line.trim())
  if (match === null) return []
  const step = { what: match[1] ?? '', file: match[2] ?? '', line: Number(match[3]), note: match[5] ?? '' }

  return [match[4] === undefined ? step : { ...step, changed: true }]
}

export const pathFrom = (sectionText: string): PathStep[] => sectionText.split('\n').flatMap(stepFrom)

const excerptBlock = (excerpt: Excerpt): string => [`${excerpt.file}:${excerpt.firstLine}`, FENCE, excerpt.lines, FENCE].join('\n')

export const excerptsSection = (excerpts: readonly Excerpt[]): string => excerpts.map(excerptBlock).join('\n\n')

type ExcerptReading = { excerpts: Excerpt[]; place: { file: string; firstLine: number } | undefined; lines: string[] | undefined }

const PLACE_LINE = /^(.+):(\d+)$/

const closeFence = (reading: ExcerptReading): void => {
  if (reading.place !== undefined) reading.excerpts.push({ ...reading.place, lines: (reading.lines ?? []).join('\n') })
  reading.lines = undefined
  reading.place = undefined
}

const readOutsideFence = (reading: ExcerptReading, line: string): void => {
  const place = PLACE_LINE.exec(line.trim())
  if (line.trim().startsWith(FENCE)) reading.lines = []
  else if (place !== null) reading.place = { file: place[1] ?? '', firstLine: Number(place[2]) }
}

const readExcerptLine = (reading: ExcerptReading, line: string): void => {
  if (reading.lines === undefined) readOutsideFence(reading, line)
  else if (line.trim() === FENCE) closeFence(reading)
  else reading.lines.push(line)
}

const FENCED_DIFF = /```diff[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*/

// A change shown before a commit is drawn as a diff, so its fence is taken out of the words around it.
export const fencedDiffOf = (text: string): { diff: string; withoutDiff: string } => {
  const match = FENCED_DIFF.exec(text)

  return match === null ? { diff: '', withoutDiff: text } : { diff: match[1] ?? '', withoutDiff: text.replace(match[0], '').replace(/\n{3,}/g, '\n\n') }
}

export const excerptsFrom =(sectionText: string): Excerpt[] => {
  const reading: ExcerptReading = { excerpts: [], place: undefined, lines: undefined }
  for (const line of sectionText.split('\n')) readExcerptLine(reading, line)

  return reading.excerpts
}
