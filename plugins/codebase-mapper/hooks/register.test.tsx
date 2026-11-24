import { expect, test } from 'claude-code/testing'

const STALE_OUTPUT = '{"stale":2,"line":"map: 2 of 7 cards stale"}'
const processResult = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('session start returns before the status script finishes, then shows one stale line', async ($, on) => {
  const statusLines: Array<string | undefined> = []
  const seenArgv: string[][] = []
  let finishScript: () => void = () => undefined
  const scriptGate = new Promise<void>(resolve => {
    finishScript = resolve
  })
  let lineShown: () => void = () => undefined
  const lineWasShown = new Promise<void>(resolve => {
    lineShown = resolve
  })

  on('fs.exists', () => ({ value: true }))
  on('process.run', async (_, e) => {
    seenArgv.push([...e.argv])
    await scriptGate

    return processResult(STALE_OUTPUT)
  })
  on('ui.status', (_, e) => {
    statusLines.push(e.text)
    lineShown()

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(statusLines).toEqual([])

  finishScript()
  await lineWasShown

  expect(statusLines).toEqual(['map: 2 of 7 cards stale'])
  expect(seenArgv[0]?.[0]).toBe('node')
  expect(seenArgv[0]?.[1]?.endsWith('/scripts/map-status.mjs')).toBe(true)
  expect(seenArgv[0]?.slice(-2)).toEqual(['--root', '/repo'])
})

test('session start still resolves with the working directory when the status script cannot run', async ($, on) => {
  const statusLines: Array<string | undefined> = []

  on('fs.exists', () => ({ value: true }))
  on('process.run', async () => {
    throw new Error('node is not installed')
  })
  on('ui.status', (_, e) => {
    statusLines.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const started = await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()

  expect(started).toEqual({ cwd: '/repo' })
  expect(statusLines).toEqual([])
})

test('a project with no card folder starts no process', async ($, on) => {
  let processStarts = 0
  const checkedPaths: string[] = []

  on('fs.exists', (_, e) => {
    checkedPaths.push(e.path)

    return { value: false }
  })
  on('process.run', async () => {
    processStarts += 1

    return processResult(STALE_OUTPUT)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()

  expect(checkedPaths.map(path => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, ''))).toEqual(['/repo/.claude/rules/map'])
  expect(processStarts).toBe(0)
})
