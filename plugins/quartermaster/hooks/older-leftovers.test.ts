import { expect, test } from 'claude-code/testing'

import { olderOnlyPluginsOn } from './older-leftovers'

test('the older-only plugins are found when switched on, not when off', () => {
  const text = JSON.stringify({ enabledPlugins: { 'quality-gate@eigenwise-toolshed': true, 'model-gateway@eigenwise-toolshed': false } })

  expect(olderOnlyPluginsOn([{ label: 'a', text, isUserWide: false }])).toEqual(['quality-gate'])
})

test('observability updates in place, so switched on it is never called an older plugin', () => {
  const text = JSON.stringify({ enabledPlugins: { 'observability@eigenwise-toolshed': true, 'quality-gate@eigenwise-toolshed': true } })

  expect(olderOnlyPluginsOn([{ label: 'a', text, isUserWide: false }])).toEqual(['quality-gate'])
})
