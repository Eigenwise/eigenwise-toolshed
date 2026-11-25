import type { Elements, RenderElement } from 'claude-code'

import type { Excerpt, PathStep } from '../../types'

export type CodePathElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'>

const PLACED_PATH = 'path-'

export const placedPathId = (storyId: string): string => `${PLACED_PATH}${storyId}`

export const storyOfPlacedPath = (placed: { id: string; plugin: string }): string | undefined =>
  placed.plugin === 'sidequest' && placed.id.startsWith(PLACED_PATH) ? placed.id.slice(PLACED_PATH.length) : undefined

const fileLine =(file: string, line: number): string => `${file}:${line}`

export const CHANGED_STEP = '(changed)'

const stepTitle = (step: PathStep): string => (step.changed ? `${step.what} ${CHANGED_STEP}` : step.what)

const stepBox = (elements: CodePathElements, step: PathStep, index: number): RenderElement => {
  const { Box, Text } = elements

  return (
    <Box key={`path-step-${index}`} borderStyle="round" {...(step.changed ? { borderColor: 'claude' } : {})} paddingX={1} flexDirection="column">
      <Text bold>{stepTitle(step)}</Text>
      <Text dimColor>{fileLine(step.file, step.line)}</Text>
      {step.note !== '' && <Text>{step.note}</Text>}
    </Box>
  )
}

const arrowRow = (elements: CodePathElements, index: number): RenderElement => {
  const { Box, Text } = elements

  return (
    <Box key={`path-arrow-${index}`} paddingLeft={2}>
      <Text dimColor>↓</Text>
    </Box>
  )
}

// Seen in a real run: each box was as wide as its own text, so the path read ragged. The column takes the widest
// step's width, never more than the surface has, and stretches every box to it, so nothing here counts columns.
export const pathDrawing = (elements: CodePathElements, path: readonly PathStep[]): RenderElement | false => {
  const { Box } = elements

  return (
    path.length > 0 && (
      <Box key="path" flexDirection="column" alignSelf="flex-start" alignItems="stretch">
        {path.flatMap((step, index) => (index === 0 ? [stepBox(elements, step, index)] : [arrowRow(elements, index), stepBox(elements, step, index)]))}
      </Box>
    )
  )
}

const AFTER_LAST_DOT = /\.([^./\\]+)$/

// A drawing of `path` named the file a second time under the line that already names it, so the language goes by the
// file's extension, which the highlighter takes as an alias, and an unknown one draws plain.
const languageOf = (file: string): string | undefined => AFTER_LAST_DOT.exec(file)?.[1]

const excerptDrawing = (elements: CodePathElements, excerpt: Excerpt, index: number): RenderElement => {
  const { Box, Code, Text } = elements
  const language = languageOf(excerpt.file)

  return (
    <Box key={`excerpt-${index}`} flexDirection="column">
      <Text dimColor>{fileLine(excerpt.file, excerpt.firstLine)}</Text>
      <Code source={excerpt.lines} startLine={excerpt.firstLine} {...(language === undefined ? {} : { language })} />
    </Box>
  )
}

export const excerptsDrawing = (elements: CodePathElements, excerpts: readonly Excerpt[]): RenderElement | false => {
  const { Box } = elements

  return (
    excerpts.length > 0 && (
      <Box key="excerpts" flexDirection="column" gap={1}>
        {excerpts.map((excerpt, index) => excerptDrawing(elements, excerpt, index))}
      </Box>
    )
  )
}
