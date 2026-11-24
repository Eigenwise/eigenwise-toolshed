import type { PathStep } from '../types'

const MOST_NODES = 10
const FENCE = '```'

// Inside a quoted Mermaid label only these can end the label or break the block, so each is written as an entity code.
const ENTITY_CODES: Record<string, string> = { '#': '#35;', '"': '#quot;', '[': '#91;', ']': '#93;', '|': '#124;', '<': '#lt;', '>': '#gt;', '`': '#96;' }

export const mermaidLabel = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/[#"[\]|<>`]/g, character => ENTITY_CODES[character] ?? character)

type KeptStep = { step: PathStep; index: number }

const isKept = (index: number, step: PathStep, lastIndex: number): boolean => index === 0 || index === lastIndex || step.changed === true

// A long path keeps its first, its changed and its last steps; past ten even so, the first nine and the last.
export const keptSteps = (path: readonly PathStep[]): KeptStep[] => {
  const all = path.map((step, index) => ({ step, index }))
  if (all.length <= MOST_NODES) return all
  const kept = all.filter(({ step, index }) => isKept(index, step, all.length - 1))

  return kept.length <= MOST_NODES ? kept : [...kept.slice(0, MOST_NODES - 1), ...kept.slice(-1)]
}

const nodeName = (kept: KeptStep): string => `step${kept.index + 1}`

const nodeLine = (kept: KeptStep): string => {
  const marked = kept.step.changed ? ' (changed)' : ''
  const label = `${mermaidLabel(kept.step.what)}${marked}<br/>${mermaidLabel(`${kept.step.file}:${kept.step.line}`)}`

  return `  ${nodeName(kept)}["${label}"]${kept.step.changed ? ':::changed' : ''}`
}

const leftOutWords = (count: number): string => (count === 1 ? '1 step left out' : `${count} steps left out`)

const edgeLine = (from: KeptStep, to: KeptStep): string => {
  const skipped = to.index - from.index - 1

  return skipped === 0 ? `  ${nodeName(from)} --> ${nodeName(to)}` : `  ${nodeName(from)} -.->|${leftOutWords(skipped)}| ${nodeName(to)}`
}

const edgeLines = (kept: readonly KeptStep[]): string[] => kept.slice(1).map((to, position) => edgeLine(kept[position] ?? to, to))

// The diagram for a pull request description, written by code from the story's path so nobody types it.
export const pathAsMermaid = (path: readonly PathStep[]): string => {
  const kept = keptSteps(path)

  return [`${FENCE}mermaid`, 'flowchart TD', ...kept.map(nodeLine), ...edgeLines(kept), '  classDef changed stroke-width:3px', FENCE].join('\n')
}
