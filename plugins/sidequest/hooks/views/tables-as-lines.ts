// A pane is too narrow for a Markdown table: in a real session the host drew one with its header off to the right and
// its cells wrapped outside their columns. A table is drawn as one line per row; the story file keeps what was written.

type Block = { isTable: boolean; lines: string[] }

const FENCE = /^\s*(```|~~~)/
const SEPARATOR_CELL = /^:?-+:?$/

const isTableRow = (line: string): boolean => line.trim().startsWith('|')

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())

const isSeparator = (line: string | undefined): boolean =>
  line !== undefined && isTableRow(line) && cellsOf(line).every(cell => SEPARATOR_CELL.test(cell))

// A text diagram in a fence can have lines that start with a bar, and a fence is drawn as written.
const outsideFences = (lines: readonly string[]): boolean[] => {
  let isInsideFence = false

  return lines.map(line => {
    const isFenceLine = FENCE.test(line)
    const isOutside = !isInsideFence && !isFenceLine
    if (isFenceLine) isInsideFence = !isInsideFence

    return isOutside
  })
}

const blocksOf = (lines: readonly string[]): Block[] => {
  const isOutside = outsideFences(lines)

  return lines.reduce<Block[]>((blocks, line, index) => {
    const isTable = isOutside[index] === true && isTableRow(line)
    const last = blocks.at(-1)

    return last !== undefined && last.isTable === isTable
      ? [...blocks.slice(0, -1), { isTable, lines: [...last.lines, line] }]
      : [...blocks, { isTable, lines: [line] }]
  }, [])
}

const underItsHeading = (heading: string | undefined, cell: string): string => (heading ? `${heading} ${cell}` : cell)

const rowAsLine = (headings: readonly string[], line: string): string => {
  const cells = cellsOf(line)
  const written = cells.filter(cell => cell !== '')
  if (written.length <= 1) return `- ${written[0] ?? ''}`.trimEnd()
  const rest = cells.slice(1).flatMap((cell, index) => (cell === '' ? [] : [underItsHeading(headings[index + 1], cell)]))

  return `- ${cells[0]}: ${rest.join(', ')}`
}

const tableAsLines = (lines: readonly string[]): string[] => {
  if (!isSeparator(lines[1])) return [...lines]
  const headings = cellsOf(lines[0] ?? '')

  return lines.slice(2).map(line => rowAsLine(headings, line))
}

export const tablesAsLines = (markdown: string): string =>
  blocksOf(markdown.split('\n'))
    .flatMap(block => (block.isTable ? tableAsLines(block.lines) : block.lines))
    .join('\n')
