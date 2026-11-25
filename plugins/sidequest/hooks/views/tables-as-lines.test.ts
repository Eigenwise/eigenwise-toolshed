import { expect, test } from 'claude-code/testing'

import { tablesAsLines } from './tables-as-lines'

test('a table is drawn as one line per row, each cell under its heading', () => {
  const analysis = ['Probe:', '', '| model | asked | served |', '| --- | :---: | ---: |', '| small, large | fast | priority |', '| tiny | fast | fast |', '', 'After.'].join('\n')

  expect(tablesAsLines(analysis)).toBe(['Probe:', '', '- small, large: asked fast, served priority', '- tiny: asked fast, served fast', '', 'After.'].join('\n'))
})

test('a row that is one sentence across the table is drawn as that sentence, and an empty cell is left out', () => {
  const analysis = ['| model | asked | served |', '|---|---|---|', '| Every model answered within a second. | | |', '| tiny | | fast |'].join('\n')

  expect(tablesAsLines(analysis)).toBe(['- Every model answered within a second.', '- tiny: served fast'].join('\n'))
})

test('lines that start with a bar inside a fence are drawn as written', () => {
  const diagram = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n')

  expect(tablesAsLines(diagram)).toBe(diagram)
})

test('bars with no separator row under them are no table', () => {
  const lines = ['| stays as it is', '| and this too'].join('\n')

  expect(tablesAsLines(lines)).toBe(lines)
})

test('text with no table comes back unchanged', () => {
  const analysis = '### Asked\n\nOne new option.\n\n- a list\n- of two'

  expect(tablesAsLines(analysis)).toBe(analysis)
})
