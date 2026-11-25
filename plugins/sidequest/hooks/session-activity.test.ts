import { expect, test } from 'claude-code/testing'

import { activityOf, clockTime, sessionAside } from './session-activity'

test('what the session is doing is said in plain words, never as a tool name', () => {
  expect(activityOf('Bash', { command: 'npm test', description: 'Running the notes tests' })).toBe('running the notes tests')
  expect(activityOf('Read', { file_path: 'C:\\repo\\src\\search\\filters.mjs' })).toBe('reading filters.mjs')
  expect(activityOf('Edit', { file_path: '/repo/src/http/server.mjs' })).toBe('editing server.mjs')
  expect(activityOf('Grep', { pattern: 'listActive' })).toBe('searching the code')
  expect(activityOf('Skill', { skill: 'sidequest:plan' })).toBe('loading the sidequest:plan skill')
  expect(activityOf('Agent', { description: 'How retries work today', prompt: '[route:explore] ...' })).toBe('how retries work today')
  expect(activityOf('mcp__issue_tracker__get_issue', { key: 'PAY-41' })).toBe('issue tracker: get issue')
  expect(activityOf('SomethingNew', {})).toBe('working')
})

test('a long line from the call itself is cut so the row keeps it', () => {
  const activity = activityOf('Bash', { description: 'Reading every file under the search folder and the tests beside it' })

  expect(activity.length).toBe(48)
  expect(activity.endsWith('...')).toBe(true)
})

test('the row says since when, on the clock, and thinking between calls', () => {
  const halfPastTwo = new Date(2026, 10, 24, 14, 32).getTime()

  expect(clockTime(halfPastTwo)).toBe('14:32')
  expect(sessionAside({ isWorking: true, steps: 3, activity: 'running the notes tests', since: halfPastTwo })).toBe(
    'running the notes tests, since 14:32',
  )
  expect(sessionAside({ isWorking: true, steps: 0 })).toBe('thinking')
})

test('finding the words for ten thousand calls takes no time a person could feel', () => {
  const started = performance.now()
  for (let call = 0; call < 10_000; call += 1) activityOf('Read', { file_path: `/repo/src/file-${call}.ts` })

  expect(performance.now() - started).toBeLessThan(250)
})
