import { expect, test } from 'claude-code/testing'

import { staleLine } from './stale-line'

test('stale cards give the status line', async () => {
  expect(staleLine('{"stale":2,"line":"map: 2 of 7 cards stale"}')).toBe('map: 2 of 7 cards stale')
})

test('a fresh map, bad output or no output gives no line', async () => {
  expect(staleLine('{"stale":0,"line":"map: all 7 cards fresh"}')).toBe(undefined)
  expect(staleLine('{"stale":"2"}')).toBe(undefined)
  expect(staleLine('null')).toBe(undefined)
  expect(staleLine('')).toBe(undefined)
})
