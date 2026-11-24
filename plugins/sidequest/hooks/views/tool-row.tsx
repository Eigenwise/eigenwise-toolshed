import type { Elements, RenderElement } from 'claude-code'

type RowElements = Pick<Elements['terminal'], 'Text'>

export const drawBoardReadResult = (elements: RowElements, line: string): RenderElement => {
  const { Text } = elements

  return <Text dimColor>{line}</Text>
}

export const drawNothing = (elements: Pick<Elements['terminal'], 'Box'>): RenderElement => {
  const { Box } = elements

  return <Box />
}

export const drawToolRow = (elements: RowElements, label: string, row: string): RenderElement => {
  const { Text } = elements

  return (
    <Text>
      <Text dimColor>{label}</Text> {row}
    </Text>
  )
}
