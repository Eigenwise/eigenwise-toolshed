import { expect, test } from 'claude-code/testing'

import { EVIDENCE_TOOL, PROPOSAL_TOOL } from './tool-specs'

const LONGEST_DESCRIPTION = 3900

test('every tool description stays short enough for the host to show the model in full', () => {
  for (const tool of [EVIDENCE_TOOL, PROPOSAL_TOOL]) {
    expect({ name: tool.name, fits: tool.description.length <= LONGEST_DESCRIPTION }).toEqual({ name: tool.name, fits: true })
  }
})
