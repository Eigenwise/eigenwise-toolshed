import type { Elements, RenderElement } from 'claude-code'

import type { PublishedSummary } from '../summary'
import { OPEN_BOARD_LABEL, bandCounts, bandLine, bandWarnings } from './board-view'
import type { BoardActivity } from './running-agents'

type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const hasNothingToSay = (summary: PublishedSummary, activity: BoardActivity): boolean =>
  bandWarnings(summary, activity) === '' && bandCounts(summary, activity) === ''

// The band stays away from a quiet board, except while another plugin holds /board: then its button is the only way
// to the board, and the person was told it is there.
export const drawBand = (
  elements: BandElements,
  summary: PublishedSummary,
  activity: BoardActivity,
  columns: number,
  openBoard: () => Promise<unknown>,
  isButtonTheOnlyWayIn = false,
): RenderElement | undefined => {
  if (hasNothingToSay(summary, activity) && !isButtonTheOnlyWayIn) return undefined
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
