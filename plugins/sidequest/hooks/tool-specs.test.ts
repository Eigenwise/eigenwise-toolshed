import { expect, test } from 'claude-code/testing'

import { boardIdsOf } from './board-ids'
import { SIDEQUEST_TOOLS, sidequestToolsOn } from './tool-specs'

const LONGEST_DESCRIPTION = 3900
const LONGEST_BOARD_PREFIX = 'ABCDEFGHIJ'

const lengthsByName = (tools: readonly { name: string; description: string }[]): Record<string, number> =>
  Object.fromEntries(tools.map(tool => [tool.name, tool.description.length]))

test('every tool description stays short enough for the host to show the model in full', () => {
  const lengths = lengthsByName(SIDEQUEST_TOOLS)

  for (const [name, length] of Object.entries(lengths)) expect({ name, fits: length <= LONGEST_DESCRIPTION }).toEqual({ name, fits: true })
})

test('a board with the longest allowed prefix still has descriptions that fit', () => {
  const lengths = lengthsByName(sidequestToolsOn(boardIdsOf(LONGEST_BOARD_PREFIX)))

  for (const [name, length] of Object.entries(lengths)) expect({ name, fits: length <= LONGEST_DESCRIPTION }).toEqual({ name, fits: true })
})
