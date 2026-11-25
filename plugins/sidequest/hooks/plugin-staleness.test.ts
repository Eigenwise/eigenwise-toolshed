import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { outdatedPluginLine, runningPluginOf } from './plugin-staleness'

const REPOSITORY = '/repo'
const CONFIG = '/home/.claude'
const RECORD_PATH = `${CONFIG}/plugins/installed_plugins.json`
const MANIFEST_SUFFIX = '/.claude-plugin/plugin.json'
const OLDER_FOLDER = '/home/.claude/plugins/cache/market/sidequest/0.8.0'
const NEWER_FOLDER = '/home/.claude/plugins/cache/market/sidequest/0.9.0'
const RUNNING_MANIFEST = JSON.stringify({ name: 'sidequest', version: '0.8.0' })
const LINE = 'sidequest 0.9.0 is installed, this session runs 0.8.0. Run /reload-plugins or restart to get it.'

const entryAt = (installPath: string, version: string, projectPath = REPOSITORY) => ({ scope: 'project', projectPath, installPath, version })

type Installed = { path: string; version: string; projectPath?: string }

type Observed = {
  toasts: string[]
  notifications: string[]
  installedRecord: (entries: Installed[], sameNameFromAnotherMarketplace?: Installed[]) => void
}

const slashed = (path: string): string => path.replace(/\\/g, '/')

// The engine gives the hooks module the real plugin folder as its root, so the test learns it from the manifest read.
const standInForEngine = (on: On): Observed => {
  let installed: Installed[] = []
  let fromAnotherMarketplace: Installed[] = []
  let root = ''
  const recordText = (): string =>
    JSON.stringify({
      version: 2,
      plugins: {
        'sidequest@older-market': fromAnotherMarketplace.map(entry => entryAt(entry.path, entry.version, entry.projectPath)),
        'sidequest@market': installed.map(entry => entryAt(entry.path === 'running' ? root : entry.path, entry.version, entry.projectPath)),
      },
    })
  const observed: Observed = {
    toasts: [],
    notifications: [],
    installedRecord: (entries, sameNameFromAnotherMarketplace = []) => {
      installed = entries
      fromAnotherMarketplace = sameNameFromAnotherMarketplace
    },
  }
  on('fs.read', (_, e) => {
    const path = slashed(e.path)
    if (path.endsWith(MANIFEST_SUFFIX)) {
      root = path.slice(0, -MANIFEST_SUFFIX.length)

      return { value: RUNNING_MANIFEST }
    }

    return path.endsWith('installed_plugins.json') ? { value: recordText() } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${REPOSITORY}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18T10:00:00Z') }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    observed.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    observed.notifications.push(e.text)

    return { value: { delivered: true } } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  return observed
}

const startSession = ($: Engine) => $.session.start({ cwd: REPOSITORY, surface: 'terminal', isInteractive: true })

const endTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: '', turnId })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('a record whose entry points at the running root says nothing at a turn end', async ($, on) => {
  const observed = standInForEngine(on)
  observed.installedRecord([{ path: 'running', version: '0.8.0' }])
  await startSession($)

  await endTurn($, 'main-1')

  expect(observed.toasts).toEqual([])
  expect(observed.notifications).toEqual([])
})

test('once the install path moves to a newer version the next turn end raises the line once', async ($, on) => {
  const observed = standInForEngine(on)
  observed.installedRecord([{ path: 'running', version: '0.8.0' }])
  await startSession($)
  await endTurn($, 'main-1')

  observed.installedRecord([{ path: NEWER_FOLDER, version: '0.9.0' }])
  await endTurn($, 'main-2')
  await endTurn($, 'main-3')

  expect(observed.toasts).toEqual([LINE])
  expect(observed.notifications).toEqual([LINE])
})

test('a newer entry for another project is not this session install', async ($, on) => {
  const observed = standInForEngine(on)
  observed.installedRecord([{ path: 'running', version: '0.8.0' }])
  await startSession($)

  observed.installedRecord([
    { path: 'running', version: '0.8.0' },
    { path: NEWER_FOLDER, version: '0.9.0', projectPath: '/elsewhere' },
  ])
  await endTurn($, 'main-1')

  expect(observed.toasts).toEqual([])
})

test('with no entry for this root at session start nothing is ever raised', async ($, on) => {
  const observed = standInForEngine(on)
  observed.installedRecord([{ path: OLDER_FOLDER, version: '0.8.0' }])
  await startSession($)

  observed.installedRecord([{ path: NEWER_FOLDER, version: '0.9.0' }])
  await endTurn($, 'main-1')

  expect(observed.toasts).toEqual([])
  expect(observed.notifications).toEqual([])
})

test('an unreadable record means no signal', async ($, on) => {
  const observed = standInForEngine(on)
  observed.installedRecord([{ path: 'running', version: '0.8.0' }])
  await startSession($)

  observed.installedRecord([])
  await endTurn($, 'main-1')

  expect(observed.toasts).toEqual([])
})

const OTHER_MARKETPLACE_FOLDER = '/home/.claude/plugins/cache/older-market/sidequest/6.10.2'

test('a plugin of the same name from another marketplace, listed first with a higher version, is not a newer install', async ($, on) => {
  const observed = standInForEngine(on)
  const fromTheOlderMarketplace = [{ path: OTHER_MARKETPLACE_FOLDER, version: '6.10.2' }]
  observed.installedRecord([{ path: 'running', version: '0.8.0' }], fromTheOlderMarketplace)
  await startSession($)

  await endTurn($, 'main-1')
  expect(observed.toasts).toEqual([])
  expect(observed.notifications).toEqual([])

  observed.installedRecord([{ path: NEWER_FOLDER, version: '0.9.0' }], fromTheOlderMarketplace)
  await endTurn($, 'main-2')
  expect(observed.toasts).toEqual([LINE])
})

test('the line compares only entries under the record key the running folder is listed under', () => {
  const root = '/home/.claude/plugins/cache/market/sidequest/0.8.0'
  const recordWith = (ownPath: string, ownVersion: string): string =>
    JSON.stringify({
      version: 2,
      plugins: {
        'sidequest@older-market': [entryAt(OTHER_MARKETPLACE_FOLDER, '6.10.2')],
        'sidequest@market': [entryAt(ownPath, ownVersion)],
      },
    })
  const running = runningPluginOf('sidequest', root, RUNNING_MANIFEST, recordWith(root, '0.8.0'))

  expect(running?.recordKey).toBe('sidequest@market')
  expect(running && outdatedPluginLine(running, recordWith(root, '0.8.0'))).toBeUndefined()
  expect(running && outdatedPluginLine(running, recordWith(NEWER_FOLDER, '0.9.0'))).toBe(LINE)
})
