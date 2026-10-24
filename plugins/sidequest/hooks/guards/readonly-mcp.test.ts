import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { deniedToolsDenial, mcpWriteWord } from './context-guards.js'
import type { SnapshotRow } from './context-guards.js'

function readOnlyRow(fields: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    ref: 'SQ-3779', sessionId: 'parent', claimSessionId: 'reader', agentId: null, agentName: null,
    executor: 'sidequest-exec-readonly-high', worktree: null, sharedTree: true,
    readonly: true, state: 'claimed', deniedTools: [], ...fields,
  }
}

function readOnlySession(on: On, cwd: string, fields: Partial<SnapshotRow> = {}) {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/test' })
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: 'reader' }))
  const snapshot = JSON.stringify({ v: 1, dispatches: [readOnlyRow(fields)] })
  on('fs.read', ($, event) => event.path.endsWith('dispatch-snapshot.json') ? { value: snapshot } : { deny: 'ENOENT' })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
}

test('read-only MCP write names are refused through the registered guard', async ($, on) => {
  readOnlySession(on, 'C:/readonly-mcp-default')
  expect(await $.tool.call({ tool: 'mcp__plugin_slack_slack__slack_send_message' })).toMatchObject({ deny: expect.stringContaining('matched send') })
  expect(await $.tool.call({ tool: 'mcp__jira__editJiraIssue' })).toMatchObject({ deny: expect.stringContaining('matched edit') })
})

test('read-only MCP reads and exact board lifecycle tools are admitted', async ($, on) => {
  readOnlySession(on, 'C:/readonly-mcp-reads')
  expect(await $.tool.call({ tool: 'mcp__plugin_slack_slack__slack_search_messages' })).toMatchObject({ text: 'ran' })
  expect(await $.tool.call({ tool: 'mcp__jira__getJiraIssue' })).toMatchObject({ text: 'ran' })
  for (const name of ['comment', 'checkpoint', 'done', 'release', 'scopeRequest']) {
    expect(await $.tool.call({ tool: `mcp__plugin_sidequest_board__${name}` })).toMatchObject({ text: 'ran' })
  }
})

test('read-only board override replaces the default list and may be empty', async ($, on) => {
  readOnlySession(on, 'C:/readonly-mcp-override', { readOnlyDeniedTools: ['mcp__jira__getJiraIssue'] })
  expect(await $.tool.call({ tool: 'mcp__jira__editJiraIssue' })).toMatchObject({ text: 'ran' })
  expect(await $.tool.call({ tool: 'mcp__jira__getJiraIssue' })).toMatchObject({ deny: expect.stringContaining('board_config readOnlyDeniedTools replaces the whole') })
  expect(deniedToolsDenial('mcp__jira__editJiraIssue', readOnlyRow({ readOnlyDeniedTools: [] }))).toBeNull()
})

test('MCP write matching stays on final word boundaries and read-only callers', () => {
  for (const word of ['send', 'post', 'create', 'add', 'edit', 'update', 'delete', 'remove', 'archive', 'transition', 'write', 'upload', 'publish', 'assign', 'comment', 'reply', 'move', 'rename']) {
    expect(mcpWriteWord(`mcp__server__${word}_item`)).toBe(word)
  }
  expect(mcpWriteWord('mcp__send__get_items')).toBeNull()
  expect(mcpWriteWord('mcp__server__get_credit')).toBeNull()
  expect(mcpWriteWord('Write')).toBeNull()
  expect(deniedToolsDenial('mcp__jira__editJiraIssue', readOnlyRow({ readonly: false }))).toBeNull()
  expect(deniedToolsDenial('mcp__jira__editJiraIssue', null)).toBeNull()
  expect(deniedToolsDenial('WebFetch', readOnlyRow({ deniedTools: ['WebFetch'] }))).toContain('board deniedTools')
  expect(deniedToolsDenial('mcp__other__comment', readOnlyRow())).toContain('mcp__other__comment')
  expect(deniedToolsDenial('mcp__plugin_sidequest_board__comment', readOnlyRow({ readOnlyDeniedTools: ['mcp__plugin_sidequest_board'] }))).toBeNull()
})
