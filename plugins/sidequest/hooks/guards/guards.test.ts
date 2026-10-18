import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const WINDOWS = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\kenny' }

// SQ-3743 probe: classic.PreToolUse gives a module only the envelope, so the guards hook tool.call.
// This pins that shape: a test hook beneath the module sees no agent_type, session_id or cwd.
test('classic.PreToolUse carries only the tool envelope, and a guard deny comes back as the deny', async ($, on) => {
  mock.env(on, WINDOWS)
  const seen: string[][] = []
  on('classic.PreToolUse', ($$, e, next) => {
    seen.push(Object.keys(e).sort())
    return next(e)
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)

  await $.tool.call({ tool: 'Bash', command: 'echo ok' })
  expect(seen).toEqual([['command', 'tool', 'tool_use_id']])

  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~' })
  expect(denied).toMatchObject({ deny: 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.' })
  expect(seen.length).toBe(1)
})

function passThrough(on: On) {
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
}

test('an unquoted Windows path in Bash is denied on Windows and allowed elsewhere', async ($, on) => {
  mock.env(on, WINDOWS)
  passThrough(on)
  const denied = await $.tool.call({ tool: 'Bash', command: 'ls C:\\Users\\kenny\\x' })
  expect(denied).toMatchObject({ deny: expect.stringContaining('sidequest: unquoted Windows path in a POSIX shell (C:\\Users\\kenny\\x)') })
})

test('a POSIX container path and a Start-Process npm shim get context, not a deny', async ($, on) => {
  mock.env(on, WINDOWS)
  passThrough(on)
  const docker = await $.tool.call({ tool: 'Bash', command: 'docker exec -w /app box ls' })
  expect(docker).toMatchObject({ text: 'ran', context: [expect.stringContaining('sidequest: Git Bash rewrites this POSIX container path')] })
  const shim = await $.tool.call({ tool: 'PowerShell', command: 'Start-Process -FilePath npm -ArgumentList run' })
  expect(shim).toMatchObject({ text: 'ran', context: [expect.stringContaining('sidequest: npm is a .cmd shim on Windows')] })
})

test('the Windows-only guards stay silent off Windows', async ($, on) => {
  mock.env(on, { HOME: '/home/kenny' })
  passThrough(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls C:\\Users\\kenny\\x' })
  expect(ran).toMatchObject({ text: 'ran' })
  expect(ran.context).toBeUndefined()
})
