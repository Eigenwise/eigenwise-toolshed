import type { Elements, RenderElement } from 'claude-code'

import type { PublishedSummary } from '../summary'
import { OPEN_BOARD_LABEL, bandCounts, bandLine, bandWarnings } from './board-view'
import type { BoardActivity } from './running-agents'

type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export const drawBand = (
  elements: BandElements,
  summary: PublishedSummary,
  activity: BoardActivity,
  columns: number,
  openBoard: () => Promise<unknown>,
): RenderElement | undefined => {
  if (bandWarnings(summary, activity) === '' && bandCounts(summary, activity) === '') return undefined
  const line = bandLine(summary, activity, columns)
  const { Box, Button, Text } = elements

  return (
    <Box flexDirection="row" columnGap={2}>
      {line.warnings !== '' && (
        <Text color="warning" wrap="truncate-end">
          {line.warnings}
        </Text>
      )}
      {line.counts !== '' && <Text wrap="truncate-end">{line.counts}</Text>}
      <Button key="open" plain label={OPEN_BOARD_LABEL} onPress={openBoard} />
    </Box>
  )
}
