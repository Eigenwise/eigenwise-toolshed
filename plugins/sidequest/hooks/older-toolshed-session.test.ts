import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

declare global {
  interface ImportMeta {
    url: string
  }
}

const PROJECT = '/repo'
// An installed copy sits in <name>/<version>/hooks, a checkout in plugins/<name>/hooks.
const PLUGIN_NAME = /\/([^/]+)\/(?:\d[^/]*\/)?hooks\//.exec(import.meta.url)?.[1] ?? ''
const CONFIG = '/home/.claude'
const QUARTERMASTER_INSTALL = `${CONFIG}/plugins/cache/eigenwise-toolshed/quartermaster/2.0.0`
const INSTALLED_PLUGINS = { 'quartermaster@eigenwise-toolshed': [{ scope: 'user', installPath: QUARTERMASTER_INSTALL, version: '2.0.0' }] }
const INSTALLED_RECORD = JSON.stringify({ version: 2, plugins: INSTALLED_PLUGINS })
const INSTALL_HINT = ' (install it first: claude plugin install quartermaster@eigenwise-toolshed)'
const SWITCH_ON_HINT = ' (switch Quartermaster back on for this project first)'

const LEFTOVER_PATHS = [`${PROJECT}/.claude/.codebase-info`, `${CONFIG}/sidequest/sidequest.db`, `${PROJECT}/.claude/live-rules`]

const WIRED_GATEWAY = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } })

const saidBy = (hint: string): Record<string, string> => ({
  'codebase-mapper': 'The older map in .claude/.codebase-info/ is not used. /codebase-mapper:map builds a new one from it.',
  sidequest: `The older board's tickets are not on this board. /quartermaster:upgrade offers to redraft the ones you pick${hint}.`,
  'live-rules': `The older rules in .claude/live-rules no longer apply. /quartermaster:upgrade converts them${hint}.`,
  quartermaster:
    'The older Toolshed left the older map in this project, the older board in your home folder and the older rules in this project, and nothing uses them now. /quartermaster:upgrade moves them.',
})

const SAID_BY = saidBy(INSTALL_HINT)

const gatewayLineFor = (hint: string): string =>
  `This project is still wired to the older model gateway in .claude/settings.local.json. /quartermaster:upgrade unwires it${hint}. If a session here cannot reach a model, delete the ANTHROPIC_BASE_URL line under env in that file by hand first. Uninstalling model-gateway before the wiring is gone would block every prompt here.`

const LOOK_PATHS = /codebase-info|sidequest\.db|live-rules|settings(\.local)?\.json|installed_plugins/

// Sidequest reads the install record at every start for its own out-of-date line.
const isReadOfTheLook = (path: string): boolean => LOOK_PATHS.test(path) && !(PLUGIN_NAME === 'sidequest' && path.endsWith('installed_plugins.json'))

const portable =(path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

type Observed = {
  toasts: string[]
  fileReads: string[]
  storeReads: number
  disk: Map<string, string>
  failExistence: { on: boolean }
}

const standInForEngine = (on: On, stored: Map<string, unknown>, present: readonly string[]): Observed => {
  const observed: Observed = { toasts: [], fileReads: [], storeReads: 0, disk: new Map(), failExistence: { on: false } }
  const paths = new Set(present)
  on('fs.exists', (_, e) => {
    if (observed.failExistence.on) throw new Error('disk gone')
    observed.fileReads.push(portable(e.path))

    return { value: paths.has(portable(e.path)) }
  })
  on('fs.read', (_, e) => {
    observed.fileReads.push(portable(e.path))
    const text = observed.disk.get(portable(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.list', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', (_, e) => {
    observed.storeReads += 1

    return { value: stored.get(e.key) }
  })
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${PROJECT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  mock.env(on, { HOME: '/home' })
  mock.clock(on, { now: Date.parse('2026-11-25T10:00:00Z') })
  on('session.cwd', () => ({ value: PROJECT }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__stub__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    observed.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { delivered: true } }) as never)
  on('ui.status', () => ({ value: undefined }))

  return observed
}

const startSession = ($: Engine) => $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })

const installQuartermaster = (observed: Observed, hooksFile: string): void => {
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, INSTALLED_RECORD)
  observed.disk.set(`${QUARTERMASTER_INSTALL}/hooks/hooks.json`, hooksFile)
}

test('the first start in a project with something left over says it once and a second start says nothing', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)

  await startSession($)
  await startSession($)

  expect(observed.toasts).toEqual([SAID_BY[PLUGIN_NAME] ?? 'no such plugin'])
})

test('a switched-on Quartermaster speaks for the others, and Quartermaster still says it', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)
  installQuartermaster(observed, '{"modules":["./register.tsx"]}')

  await startSession($)

  expect(observed.toasts).toHaveLength(PLUGIN_NAME === 'quartermaster' ? 1 : 0)
})

test('a Quartermaster that is switched off in the project does not speak for the others, and the line says to switch it back on', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)
  installQuartermaster(observed, '{"modules":["./register.tsx"]}')
  observed.disk.set(`${PROJECT}/.claude/settings.local.json`, '{"enabledPlugins":{"quartermaster@eigenwise-toolshed":false}}')

  await startSession($)

  expect(observed.toasts).toEqual([saidBy(SWITCH_ON_HINT)[PLUGIN_NAME] ?? 'no such plugin'])
})

test('the older Quartermaster, which has no module, does not speak for the others', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)
  installQuartermaster(observed, '{"hooks":{"SessionStart":[]}}')

  await startSession($)

  expect(observed.toasts).toEqual([SAID_BY[PLUGIN_NAME] ?? 'no such plugin'])
})

test('a project with nothing left over says nothing, reads a few paths once, and a second start reads no file', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])

  await startSession($)
  const readsOfTheLook = (): number => observed.fileReads.filter(path => isReadOfTheLook(path)).length
  const readsAtFirstStart = readsOfTheLook()
  const firstList = observed.fileReads.filter(path => isReadOfTheLook(path))
  const storeReadsAtFirstStart = observed.storeReads
  await startSession($)

  expect(observed.toasts).toEqual([])
  expect(readsAtFirstStart).toBeLessThan(10)
  expect(observed.fileReads.filter(path => isReadOfTheLook(path)).slice(firstList.length)).toEqual([])
  expect(observed.storeReads - storeReadsAtFirstStart).toBe(1)
})

test('a check that throws says nothing and the session still starts', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)
  observed.failExistence.on = true

  const started = await startSession($)

  expect(started).toEqual({ cwd: PROJECT })
  expect(observed.toasts).toEqual([])
})

test('a wired gateway is named first, with the file and the line to delete, whichever plugin says it', async ($, on) => {
  const observed = standInForEngine(on, new Map(), LEFTOVER_PATHS)
  observed.disk.set(`${PROJECT}/.claude/settings.local.json`, WIRED_GATEWAY)

  await startSession($)

  const [gatewayText, ownText] = observed.toasts[0]?.split('\n') ?? []
  expect(observed.toasts).toHaveLength(1)
  expect(gatewayText).toBe(gatewayLineFor(PLUGIN_NAME === 'quartermaster' ? '' : INSTALL_HINT))
  expect(ownText).toBe(SAID_BY[PLUGIN_NAME])
})

test('a gateway wired in the user settings is said for every project and names that file', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  observed.disk.set(`${CONFIG}/settings.json`, WIRED_GATEWAY)

  await startSession($)

  const hint = PLUGIN_NAME === 'quartermaster' ? '' : INSTALL_HINT

  expect(observed.toasts).toEqual([
    `Every project on this machine is still wired to the older model gateway in /home/.claude/settings.json. /quartermaster:upgrade unwires it${hint}. If a session in any project cannot reach a model, delete the ANTHROPIC_BASE_URL line under env in that file by hand first. Uninstalling model-gateway before the wiring is gone would block every prompt in every project.`,
  ])
})

test('a gateway is left to Quartermaster when one speaks', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  installQuartermaster(observed, '{"modules":["./register.tsx"]}')
  observed.disk.set(`${PROJECT}/.claude/settings.local.json`, WIRED_GATEWAY)

  await startSession($)

  expect(observed.toasts).toHaveLength(PLUGIN_NAME === 'quartermaster' ? 1 : 0)
})

test('a local proxy with a common key is not named as the gateway', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  observed.disk.set(`${PROJECT}/.claude/settings.local.json`, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' } }))

  await startSession($)

  expect(observed.toasts).toEqual([])
})

const installsFromBothNames = (plugin: string): Record<string, unknown> => ({
  [`${plugin}@toolshed-next`]: [{ scope: 'user', installPath: `${CONFIG}/plugins/cache/toolshed-next/${plugin}/7.0.0` }],
  [`${plugin}@eigenwise-toolshed`]: [{ scope: 'user', installPath: `${CONFIG}/plugins/cache/eigenwise-toolshed/${plugin}/7.0.0` }],
})

const installedFromBothNames = (plugin: string): string => JSON.stringify({ version: 2, plugins: installsFromBothNames(plugin) })

const INSTALLED_TWICE_LINE = `${PLUGIN_NAME} is also installed from toolshed-next. Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. To remove the toolshed-next copy, run: claude plugin uninstall ${PLUGIN_NAME}@toolshed-next.`

test('the copy from the shared name says it is installed twice once, and the next start says nothing', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, installedFromBothNames(PLUGIN_NAME))

  await startSession($)
  await startSession($)

  expect(observed.toasts).toEqual([INSTALLED_TWICE_LINE])
})

test('the same line is said once per machine, not once per project', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, installedFromBothNames(PLUGIN_NAME))

  await startSession($)
  await $.session.start({ cwd: '/other-repo', surface: 'terminal', isInteractive: true })

  expect(observed.toasts).toEqual([INSTALLED_TWICE_LINE])
})

test('a plugin installed under one name only says nothing about two copies', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, INSTALLED_RECORD)

  await startSession($)

  expect(observed.toasts).toEqual([])
})

test('Quartermaster says it for another plugin that is installed twice, and that plugin stays quiet', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  const other = PLUGIN_NAME === 'sidequest' ? 'live-rules' : 'sidequest'
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: { ...installsFromBothNames(other), ...INSTALLED_PLUGINS } }))
  observed.disk.set(`${QUARTERMASTER_INSTALL}/hooks/hooks.json`, '{"modules":["./register.tsx"]}')

  await startSession($)

  const saidForTheOther = `${other} is also installed from toolshed-next. Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. To remove the toolshed-next copy, run: claude plugin uninstall ${other}@toolshed-next.`
  expect(observed.toasts).toEqual(PLUGIN_NAME === 'quartermaster' ? [saidForTheOther] : [])
})

type InstalledCopy = { marketplace: string; scope: string }

const installsAt = (plugin: string, copies: readonly InstalledCopy[]): string =>
  JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      [...new Set(copies.map(copy => copy.marketplace))].map(marketplace => [
        `${plugin}@${marketplace}`,
        copies
          .filter(copy => copy.marketplace === marketplace)
          .map(copy => ({ scope: copy.scope, projectPath: copy.scope === 'user' ? undefined : PROJECT, installPath: `${CONFIG}/plugins/cache/${marketplace}/${plugin}/7.0.0` })),
      ]),
    ),
  })

const SAID_BEFORE_THE_COMMANDS = `${PLUGIN_NAME} is also installed from toolshed-next. Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. To remove the toolshed-next copy, run: `

test('the copy at project scope is removed from the project folder, and the line says so', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  const record = installsAt(PLUGIN_NAME, [
    { marketplace: 'toolshed-next', scope: 'project' },
    { marketplace: 'eigenwise-toolshed', scope: 'user' },
  ])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, record)

  await startSession($)

  expect(observed.toasts).toEqual([`${SAID_BEFORE_THE_COMMANDS}claude plugin uninstall ${PLUGIN_NAME}@toolshed-next --scope project. Run the ones with --scope from ${PROJECT}.`])
})

test('the copy at two scopes is removed at both, in one line', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  const record = installsAt(PLUGIN_NAME, [
    { marketplace: 'toolshed-next', scope: 'user' },
    { marketplace: 'toolshed-next', scope: 'project' },
    { marketplace: 'eigenwise-toolshed', scope: 'user' },
  ])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, record)

  await startSession($)

  const both = `claude plugin uninstall ${PLUGIN_NAME}@toolshed-next; claude plugin uninstall ${PLUGIN_NAME}@toolshed-next --scope project.`
  expect(observed.toasts).toEqual([`${SAID_BEFORE_THE_COMMANDS}${both} Run the ones with --scope from ${PROJECT}.`])
})

test('the user settings switch on only the earlier-name copy: the line adds the install that keeps the other projects', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  const record = installsAt(PLUGIN_NAME, [
    { marketplace: 'toolshed-next', scope: 'user' },
    { marketplace: 'eigenwise-toolshed', scope: 'project' },
  ])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, record)
  observed.disk.set(`${CONFIG}/settings.json`, JSON.stringify({ enabledPlugins: { [`${PLUGIN_NAME}@toolshed-next`]: true } }))
  observed.disk.set(`${PROJECT}/.claude/settings.json`, JSON.stringify({ enabledPlugins: { [`${PLUGIN_NAME}@eigenwise-toolshed`]: true } }))

  await startSession($)

  expect(observed.toasts.length).toBe(1)
  expect(observed.toasts[0]?.endsWith(`Your other projects get ${PLUGIN_NAME} from the toolshed-next copy. To keep it there, also run: claude plugin install ${PLUGIN_NAME}@eigenwise-toolshed. A project where you switched the eigenwise-toolshed copy off itself stops running ${PLUGIN_NAME} with this. Switch it on there, from that project's folder: claude plugin enable ${PLUGIN_NAME}@eigenwise-toolshed --scope local.`)).toBe(true)
})

test('the only copy that is switched on is not the one the line says to remove first', async ($, on) => {
  const observed = standInForEngine(on, new Map(), [])
  const record = installsAt(PLUGIN_NAME, [
    { marketplace: 'eigenwise-toolshed', scope: 'user' },
    { marketplace: 'toolshed-next', scope: 'local' },
  ])
  observed.disk.set(`${CONFIG}/plugins/installed_plugins.json`, record)
  observed.disk.set(
    `${PROJECT}/.claude/settings.local.json`,
    JSON.stringify({ enabledPlugins: { [`${PLUGIN_NAME}@toolshed-next`]: true, [`${PLUGIN_NAME}@eigenwise-toolshed`]: false } }),
  )

  await startSession($)

  expect(observed.toasts).toEqual([
    `${PLUGIN_NAME} is installed from toolshed-next and from eigenwise-toolshed, and here only the toolshed-next copy is switched on. Switch the eigenwise-toolshed copy on for this project first, from the project folder: claude plugin enable ${PLUGIN_NAME}@eigenwise-toolshed --scope local. Then remove the toolshed-next copy: claude plugin uninstall ${PLUGIN_NAME}@toolshed-next --scope local. Run the ones with --scope from ${PROJECT}.`,
  ])
})
