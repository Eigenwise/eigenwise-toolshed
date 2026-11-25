import { expect, test } from 'claude-code/testing'

import { commandPrefix, eventLines, failureSignature, parseEventLines, projectSlug } from './events'
import { denialEvent, toolCallEvents, typedBashCommand, typedShellEvents } from './sensing'

test('a command prefix keeps the first two plain words', async () => {
  expect(commandPrefix('npm run build -- --watch')).toBe('npm run')
  expect(commandPrefix('git -C /work/repo status --short')).toBe('git status')
  expect(commandPrefix('  Docker compose up -d')).toBe('docker compose')
})

test('a command prefix never keeps arguments, paths or quoted strings', async () => {
  expect(commandPrefix('cat ./config/secrets.env')).toBe('cat')
  expect(commandPrefix('node C:\\tools\\run.mjs --fast')).toBe('node')
  expect(commandPrefix('grep "password=hunter2" notes.txt')).toBe('grep')
  expect(commandPrefix("echo 'top secret words' | wc -l")).toBe('echo')
})

test('a command prefix drops secrets and variable assignments', async () => {
  expect(commandPrefix('GITHUB_TOKEN=ghp_abc123def456ghi789 gh release create')).toBe('gh release')
  expect(commandPrefix('curl sk9f8e7d6c5b4a3f2e1d0c')).toBe('curl')
  expect(commandPrefix('export API_KEY=abc123; npm test')).toBe('export')
  expect(commandPrefix('ls && rm -rf /tmp/thing')).toBe('ls')
})

test('a failure signature keeps the words and drops what varies', async () => {
  expect(failureSignature('File does not exist: C:\\work\\a.ts\nmore output')).toBe('file does not exist')
  expect(failureSignature('String "const x = 1" not found in 3 places')).toBe('string not found in places')
})

test('a failed Bash call records the command and the words of an error of the environment, never the arguments or the output', async () => {
  const events = toolCallEvents(
    { tool: 'Bash', command: 'npm test -- --token=abc', isError: true, errorText: 'Exit code 127\nsecret output\nnpm: command not found' },
    '2026-11-16T10:00:00.000Z',
  )

  expect(events).toEqual([
    { kind: 'failure', at: '2026-11-16T10:00:00.000Z', tool: 'Bash', signature: 'npm test', error: 'npm: command not found' },
  ])
  expect(JSON.stringify(events).includes('secret')).toBe(false)
  expect(JSON.stringify(events).includes('--token')).toBe(false)
})

const AT = '2026-11-16T10:00:00.000Z'

const shellFailure = (command: string, errorText: string) =>
  toolCallEvents({ tool: 'Bash', command, isError: true, errorText }, AT)

test('a failed cd-and-command call is named after the command, and a failing test keeps no words of its output', async () => {
  expect(shellFailure('cd /work/repo && npm test', 'Exit code 1\nTests failed in 3 files\nmore lines')).toEqual([
    { kind: 'failure', at: AT, tool: 'Bash', signature: 'npm test', error: '' },
  ])
})

test('a call the person rejected is no failure, for a shell and for any other tool', async () => {
  const rejection = "The user doesn't want to proceed with this tool use. The tool use was rejected."

  expect(shellFailure('cd /work/repo && git push', rejection)).toEqual([])
  expect(toolCallEvents({ tool: 'Edit', isError: true, errorText: rejection }, AT)).toEqual([])
})

test('exit 1 from grep, rg, diff, test and git diff is no failure', async () => {
  for (const command of ['grep -q needle file', 'rg needle', 'diff a b', 'test -d out', 'git diff --quiet']) {
    expect(shellFailure(command, 'Exit code 1')).toEqual([])
  }
})

test('an exit code other than 1 from grep is a failure', async () => {
  expect(shellFailure('grep needle missing', 'Exit code 2\ngrep: No such file').map(event => event.kind)).toEqual(['failure'])
})

test('a typed shell line is kept as its prefix under its own kind', async () => {
  expect(typedShellEvents('git status --short', 'now')).toEqual([{ kind: 'typed', at: 'now', prefix: 'git status' }])
  expect(typedShellEvents('--short', 'now')).toEqual([])
})

test('only a bash-input row counts as a typed command', async () => {
  const text = (value: string) => [{ type: 'text', text: value }]

  expect(typedBashCommand(text('<bash-input>git status -s</bash-input>'))).toBe('git status -s')
  expect(typedBashCommand([{ type: 'text', text: 'note' }, ...text('<bash-input>npm test</bash-input>')])).toBe('npm test')
  expect(typedBashCommand(text('<bash-stdout>clean</bash-stdout>'))).toBeUndefined()
  expect(typedBashCommand(text('<command-name>/quartermaster</command-name>'))).toBeUndefined()
})

test('a denial of Bash names the prefix, other tools name themselves', async () => {
  expect(denialEvent('Bash', { command: 'git push origin main' }, 'now')).toEqual({
    kind: 'denial',
    at: 'now',
    tool: 'Bash',
    target: 'git push',
  })
  expect(denialEvent('WebFetch', { url: 'https://example.com' }, 'now').target).toBe('WebFetch')
})

test('events survive a round trip through JSON lines and a torn line is skipped', async () => {
  const events = toolCallEvents({ tool: 'Read', isError: true, errorText: 'File does not exist.' }, '2026-11-16T10:00:00.000Z')

  expect(parseEventLines(`${eventLines(events)}{"kind":"comm`)).toEqual(events)
})

test('a project slug is the path in lowercase words', async () => {
  expect(projectSlug('C:\\work\\Photo Library')).toBe('c-work-photo-library')
  expect(projectSlug('/home/me/repo')).toBe('home-me-repo')
})
