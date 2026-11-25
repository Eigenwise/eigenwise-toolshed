import { expect, test } from 'claude-code/testing'

import {
  copyNoticeFor,
  displayedPath,
  gatewayLine,
  plainLines,
  quartermasterLines,
  installedEntriesOf,
  installedTwiceLine,
  installedUnderBothNames,
  isRunningFromThePrivateMarketplace,
  moveMarketplaceLine,
  pluginsInstalledFromThePrivateMarketplace,
  quartermasterInstallsFor,
} from './older-toolshed'

const RECORD = JSON.stringify({
  version: 2,
  plugins: {
    'sidequest@toolshed-next': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/toolshed-next/sidequest/0.9.0' }],
    'live-rules@toolshed-next': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/toolshed-next/live-rules/0.6.0' }],
    'observability@toolshed-next': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/toolshed-next/observability/0.3.1' }],
    'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:\\work\\app', installPath: '/h/q' }],
    'other@toolshed-next': [{ scope: 'user', installPath: '/h/o' }],
  },
})

test('a plugin whose folder is under the private marketplace is told apart from one under the public name', () => {
  expect(isRunningFromThePrivateMarketplace('C:\\Users\\a\\.claude\\plugins\\cache\\toolshed-next\\sidequest\\0.9.0')).toBe(true)
  expect(isRunningFromThePrivateMarketplace('/h/.claude/plugins/cache/eigenwise-toolshed/sidequest/7.0.0')).toBe(false)
  expect(isRunningFromThePrivateMarketplace('/dev/plugins/sidequest')).toBe(false)
})

test('the plugins installed from the private marketplace are the Toolshed ones only, each once', () => {
  expect(pluginsInstalledFromThePrivateMarketplace(installedEntriesOf(RECORD))).toEqual(['sidequest', 'live-rules', 'observability'])
})

test('a project install of Quartermaster counts for its folder and the folders below it, not for another project', () => {
  const entries = installedEntriesOf(RECORD)

  expect(quartermasterInstallsFor(entries, 'C:/work/app/packages/x')).toHaveLength(1)
  expect(quartermasterInstallsFor(entries, 'C:/work/other')).toHaveLength(0)
})

test('a record that is not JSON has no entries', () => {
  expect(installedEntriesOf('not json')).toEqual([])
})

test('the move line lists the commands in order, naming each plugin', () => {
  expect(moveMarketplaceLine(['sidequest', 'live-rules'])).toBe(
    'sidequest and live-rules came from toolshed-next, a name that is gone. To move to eigenwise-toolshed, run: claude plugin uninstall sidequest@toolshed-next; claude plugin uninstall live-rules@toolshed-next; claude plugin marketplace remove toolshed-next; claude plugin marketplace add Eigenwise/eigenwise-toolshed; claude plugin install sidequest@eigenwise-toolshed; claude plugin install live-rules@eigenwise-toolshed.',
  )
})

test('the gateway line names the file, the one line to delete, what takes out the rest and the warning', () => {
  const projectWiring = { file: '.claude/settings.local.json', isUserWide: false }
  const userWiring = { file: '/home/a/.claude/settings.json', isUserWide: true }

  expect(gatewayLine(projectWiring, 'none')).toBe(
    'This project is still wired to the older model gateway in .claude/settings.local.json. /quartermaster:upgrade unwires it. If a session here cannot reach a model, delete the ANTHROPIC_BASE_URL line under env in that file by hand first. Uninstalling model-gateway before the wiring is gone would block every prompt here.',
  )
  expect(gatewayLine(userWiring, 'switch-on')).toBe(
    'Every project on this machine is still wired to the older model gateway in /home/a/.claude/settings.json. /quartermaster:upgrade unwires it (switch Quartermaster back on for this project first). If a session in any project cannot reach a model, delete the ANTHROPIC_BASE_URL line under env in that file by hand first. Uninstalling model-gateway before the wiring is gone would block every prompt in every project.',
  )
})

test('a path in the platform separator is shown with that separator throughout', () => {
  expect(displayedPath('C:\\Users\\someone/.claude/settings.json')).toBe('C:\\Users\\someone\\.claude\\settings.json')
  expect(displayedPath('/home/someone/.claude/settings.json')).toBe('/home/someone/.claude/settings.json')
})

test('Quartermaster agrees the number all the way through: one thing is it, several are them', () => {
  const map = { kind: 'map' as const, where: '.claude/.codebase-info/' }
  const board = { kind: 'board' as const, where: 'x' }
  const rules = { kind: 'rules' as const, where: '.claude/live-rules' }

  expect(quartermasterLines([map], [], undefined)).toEqual([
    'The older Toolshed left the older map in this project, and nothing uses it now. /quartermaster:upgrade moves it.',
  ])
  expect(quartermasterLines([board], [], undefined)).toEqual([
    'The older Toolshed left the older board in your home folder, and nothing uses it now. /quartermaster:upgrade moves it.',
  ])
  expect(quartermasterLines([rules], [], undefined)).toEqual([
    'The older Toolshed left the older rules in this project, and nothing uses them now. /quartermaster:upgrade moves them.',
  ])
  expect(quartermasterLines([map, board], [], undefined)).toEqual([
    'The older Toolshed left the older map in this project and the older board in your home folder, and nothing uses them now. /quartermaster:upgrade moves them.',
  ])
  expect(quartermasterLines([], [], undefined)).toEqual([])
})

test('the older plugins are their own sentence, one plugin or several, apart from the leftovers', () => {
  const map = { kind: 'map' as const, where: '.claude/.codebase-info/' }

  expect(quartermasterLines([], ['quality-gate'], undefined)).toEqual([
    'The older plugin quality-gate is still switched on. /quartermaster:upgrade moves it.',
  ])
  expect(quartermasterLines([], ['quality-gate', 'model-gateway'], undefined)).toEqual([
    'The older plugins quality-gate and model-gateway are still switched on. /quartermaster:upgrade moves them.',
  ])
  expect(quartermasterLines([map], ['quality-gate'], undefined)).toEqual([
    'The older Toolshed left the older map in this project, and nothing uses it now. The older plugin quality-gate is still switched on. /quartermaster:upgrade moves them.',
  ])
})

test('a wired gateway covers the gateway plugin, so the plugin sentence leaves it out', () => {
  const wiring = { file: '.claude/settings.local.json', isUserWide: false }

  const lines = quartermasterLines([], ['quality-gate', 'model-gateway'], wiring)

  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('The older plugin quality-gate is still switched on. /quartermaster:upgrade moves it.')
  expect(quartermasterLines([], ['model-gateway'], wiring)).toEqual([gatewayLine(wiring, 'none')])
})

test('the hint says to install Quartermaster, or to switch it back on, only where the line points at it', () => {
  const rules = { kind: 'rules' as const, where: '.claude/live-rules.md' }
  const map = { kind: 'map' as const, where: '.claude/.codebase-info/' }

  expect(plainLines([rules], undefined, 'none')).toEqual(['The older rules in .claude/live-rules.md no longer apply. /quartermaster:upgrade converts them.'])
  expect(plainLines([rules], undefined, 'install')).toEqual([
    'The older rules in .claude/live-rules.md no longer apply. /quartermaster:upgrade converts them (install it first: claude plugin install quartermaster@eigenwise-toolshed).',
  ])
  expect(plainLines([rules], undefined, 'switch-on')).toEqual([
    'The older rules in .claude/live-rules.md no longer apply. /quartermaster:upgrade converts them (switch Quartermaster back on for this project first).',
  ])
  expect(plainLines([map], undefined, 'install')).toEqual(['The older map in .claude/.codebase-info/ is not used. /codebase-mapper:map builds a new one from it.'])
})

const APP = 'C:\\work\\app'
const OTHER_APP = 'C:\\work\\other'

type Copy = { marketplace: string; scope: string; projectPath?: string }

const recordWithCopies = (copies: readonly Copy[]): string => {
  const marketplaces = [...new Set(copies.map(copy => copy.marketplace))]

  return JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      marketplaces.map(marketplace => [
        `sidequest@${marketplace}`,
        copies
          .filter(copy => copy.marketplace === marketplace)
          .map(copy => ({ scope: copy.scope, projectPath: copy.projectPath, installPath: `/h/${marketplace}/sidequest/7.0.0` })),
      ]),
    ),
  })
}

const NEXT = 'toolshed-next'
const SHARED = 'eigenwise-toolshed'

const TWICE_LAYOUTS: { name: string; copies: Copy[]; saysItFor: string[] }[] = [
  { name: 'both at user scope, the earlier name installed first', copies: [{ marketplace: NEXT, scope: 'user' }, { marketplace: SHARED, scope: 'user' }], saysItFor: ['sidequest'] },
  { name: 'both at user scope, the shared name installed first', copies: [{ marketplace: SHARED, scope: 'user' }, { marketplace: NEXT, scope: 'user' }], saysItFor: ['sidequest'] },
  {
    name: 'the earlier name at project scope, the shared name at user scope',
    copies: [{ marketplace: NEXT, scope: 'project', projectPath: APP }, { marketplace: SHARED, scope: 'user' }],
    saysItFor: ['sidequest'],
  },
  {
    name: 'the earlier name at user scope, the shared name at project scope',
    copies: [{ marketplace: NEXT, scope: 'user' }, { marketplace: SHARED, scope: 'project', projectPath: APP }],
    saysItFor: ['sidequest'],
  },
  {
    name: 'the earlier name at local scope, the shared name at project scope',
    copies: [{ marketplace: NEXT, scope: 'local', projectPath: APP }, { marketplace: SHARED, scope: 'project', projectPath: APP }],
    saysItFor: ['sidequest'],
  },
  {
    name: 'both at project scope in another project',
    copies: [{ marketplace: NEXT, scope: 'project', projectPath: OTHER_APP }, { marketplace: SHARED, scope: 'project', projectPath: OTHER_APP }],
    saysItFor: [],
  },
  { name: 'only the earlier name', copies: [{ marketplace: NEXT, scope: 'user' }], saysItFor: [] },
  { name: 'only the shared name', copies: [{ marketplace: SHARED, scope: 'user' }], saysItFor: [] },
]

for (const layout of TWICE_LAYOUTS) {
  test(`installed from both names: ${layout.name}`, () => {
    const doubled = installedUnderBothNames(installedEntriesOf(recordWithCopies(layout.copies)), 'C:/work/app/src', [])

    expect(doubled.map(entry => entry.plugin)).toEqual(layout.saysItFor)
  })
}

test('different plugins under the two names are not installed twice', () => {
  const record = JSON.stringify({
    version: 2,
    plugins: {
      'sidequest@toolshed-next': [{ scope: 'user', installPath: '/h/a' }],
      'quartermaster@eigenwise-toolshed': [{ scope: 'user', installPath: '/h/b' }],
    },
  })

  expect(installedUnderBothNames(installedEntriesOf(record), APP, [])).toEqual([])
})

const userCopy = { scope: 'user', projectPath: undefined }

test('the line names the plugin, says it is also installed from toolshed-next, that one copy runs, and the command', () => {
  expect(installedTwiceLine([{ plugin: 'sidequest', earlierNameCopies: [userCopy], isOnlyEarlierNameCopySwitchedOn: false, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false }])).toBe(
    'sidequest is also installed from toolshed-next. Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. To remove the toolshed-next copy, run: claude plugin uninstall sidequest@toolshed-next.',
  )
})

const NOT_TOLD = { wasInstalledTwiceTold: false, wasMoveTold: false }

test('a plugin installed from both names says so, whichever copy runs, once', () => {
  const twice = { isInstalledTwice: true, ...NOT_TOLD }

  expect(copyNoticeFor({ ...twice, isRunningFromThePrivateMarketplace: false })).toBe('installed-twice')
  expect(copyNoticeFor({ ...twice, isRunningFromThePrivateMarketplace: true })).toBe('installed-twice')
  expect(copyNoticeFor({ ...twice, isRunningFromThePrivateMarketplace: false, wasInstalledTwiceTold: true, wasMoveTold: false })).toBe('none')
  expect(copyNoticeFor({ ...twice, isRunningFromThePrivateMarketplace: true, wasInstalledTwiceTold: true, wasMoveTold: false })).toBe('none')
})

test('the copy from the earlier name never tells the move once the other copy is installed', () => {
  const twiceAfterTheMoveWasTold = { isInstalledTwice: true, isRunningFromThePrivateMarketplace: true, wasInstalledTwiceTold: true, wasMoveTold: false }

  expect(copyNoticeFor(twiceAfterTheMoveWasTold)).not.toBe('move')
})

test('the copy from the earlier name alone tells the move once, and the copy from the shared name alone says nothing', () => {
  const alone = { isInstalledTwice: false, ...NOT_TOLD }

  expect(copyNoticeFor({ ...alone, isRunningFromThePrivateMarketplace: true })).toBe('move')
  expect(copyNoticeFor({ ...alone, isRunningFromThePrivateMarketplace: true, wasMoveTold: true, wasInstalledTwiceTold: false })).toBe('none')
  expect(copyNoticeFor({ ...alone, isRunningFromThePrivateMarketplace: false })).toBe('none')
})

test('the line for several plugins lists them, and a copy at project scope is removed at that scope', () => {
  const line = installedTwiceLine([
    { plugin: 'sidequest', earlierNameCopies: [userCopy], isOnlyEarlierNameCopySwitchedOn: false, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false },
    { plugin: 'live-rules', earlierNameCopies: [{ scope: 'project', projectPath: APP }], isOnlyEarlierNameCopySwitchedOn: false, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false },
  ])

  expect(line).toContain('sidequest and live-rules are also installed from toolshed-next.')
  expect(line).toContain('claude plugin uninstall sidequest@toolshed-next; claude plugin uninstall live-rules@toolshed-next --scope project.')
})

test('a copy at project or local scope is removed from the project folder, and the line says so', () => {
  const line = installedTwiceLine([{ plugin: 'sidequest', earlierNameCopies: [{ scope: 'local', projectPath: APP }], isOnlyEarlierNameCopySwitchedOn: false, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false }])

  expect(line).toContain(`claude plugin uninstall sidequest@toolshed-next --scope local. Run the ones with --scope from ${APP}.`)
})

test('a user scope copy alone needs no folder', () => {
  const line = installedTwiceLine([{ plugin: 'sidequest', earlierNameCopies: [userCopy], isOnlyEarlierNameCopySwitchedOn: false, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false }])

  expect(line).not.toContain('Run the ones with --scope')
})

const sidequestIn = (copies: readonly Copy[], settingsTexts: readonly string[], userSettingsText?: string) =>
  installedUnderBothNames(installedEntriesOf(recordWithCopies(copies)), APP, settingsTexts, userSettingsText)

const switchedKeys = (keys: Record<string, boolean>): string => JSON.stringify({ enabledPlugins: keys })

test('the earlier-name copy at two scopes is removed at both, each command named', () => {
  const copies = [
    { marketplace: NEXT, scope: 'user' },
    { marketplace: NEXT, scope: 'project', projectPath: APP },
    { marketplace: SHARED, scope: 'local', projectPath: APP },
  ]
  const [doubled] = sidequestIn(copies, [])

  expect(installedTwiceLine(doubled === undefined ? [] : [doubled])).toContain(
    'claude plugin uninstall sidequest@toolshed-next; claude plugin uninstall sidequest@toolshed-next --scope project.',
  )
})

test('the earlier-name copy at three scopes with the shared copy beside it is kept at all three scopes', () => {
  const copies = [
    { marketplace: NEXT, scope: 'user' },
    { marketplace: NEXT, scope: 'project', projectPath: APP },
    { marketplace: NEXT, scope: 'local', projectPath: APP },
    { marketplace: SHARED, scope: 'user' },
  ]
  const [doubled] = sidequestIn(copies, [])

  expect(doubled?.earlierNameCopies.map(copy => copy.scope)).toEqual(['user', 'project', 'local'])
})

const ONLY_EARLIER_ON_COPIES = [
  { marketplace: SHARED, scope: 'user' },
  { marketplace: NEXT, scope: 'local', projectPath: APP },
]

test('the shared copy switched off here and the earlier-name copy on: the line does not say to uninstall the only copy that is on', () => {
  const [doubled] = sidequestIn(ONLY_EARLIER_ON_COPIES, [switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': false })])

  expect(doubled?.isOnlyEarlierNameCopySwitchedOn).toBe(true)
  const line = installedTwiceLine(doubled === undefined ? [] : [doubled])
  expect(line).toContain(
    'here only the toolshed-next copy is switched on. Switch the eigenwise-toolshed copy on for this project first, from the project folder: claude plugin enable sidequest@eigenwise-toolshed --scope local. Then remove the toolshed-next copy: claude plugin uninstall sidequest@toolshed-next --scope local.',
  )
  expect(line).not.toContain('Claude Code runs only one copy')
})

test('the earlier-name copy switched off and the shared copy on: the plain line, the copy to remove is the one that is off', () => {
  const [doubled] = sidequestIn(ONLY_EARLIER_ON_COPIES, [switchedKeys({ 'sidequest@toolshed-next': false, 'sidequest@eigenwise-toolshed': true })])

  expect(doubled?.isOnlyEarlierNameCopySwitchedOn).toBe(false)
})

test('both copies switched off: nothing is only on, so the plain line stands', () => {
  const [doubled] = sidequestIn(ONLY_EARLIER_ON_COPIES, [switchedKeys({ 'sidequest@toolshed-next': false, 'sidequest@eigenwise-toolshed': false })])

  expect(doubled?.isOnlyEarlierNameCopySwitchedOn).toBe(false)
})

test('the first settings file that names the key decides: local before committed before user', () => {
  const local = switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': true })
  const user = switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': false })
  const [shownByLocal] = sidequestIn(ONLY_EARLIER_ON_COPIES, [local, user])
  const [shownByUser] = sidequestIn(ONLY_EARLIER_ON_COPIES, [user, local])

  expect(shownByLocal?.isOnlyEarlierNameCopySwitchedOn).toBe(false)
  expect(shownByUser?.isOnlyEarlierNameCopySwitchedOn).toBe(true)
})

test('a settings file that cannot be read or names no key switches no copy on', () => {
  const [doubled] = sidequestIn(ONLY_EARLIER_ON_COPIES, ['{not json', '{}', switchedKeys({ 'sidequest@other': false })])

  expect(doubled?.isOnlyEarlierNameCopySwitchedOn).toBe(false)
})

test('a copy that no settings file names is off: with only the earlier-name key written, that copy is the only one on', () => {
  const [doubled] = sidequestIn(ONLY_EARLIER_ON_COPIES, [switchedKeys({ 'sidequest@toolshed-next': true })])

  expect(doubled?.isOnlyEarlierNameCopySwitchedOn).toBe(true)
})

test('two plugins with only the earlier-name copy on get one enable command each', () => {
  const localCopy = { scope: 'local', projectPath: APP }
  const line = installedTwiceLine([
    { plugin: 'sidequest', earlierNameCopies: [localCopy], isOnlyEarlierNameCopySwitchedOn: true, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false },
    { plugin: 'live-rules', earlierNameCopies: [localCopy], isOnlyEarlierNameCopySwitchedOn: true, isOnlyEarlierNameCopyOnInOtherProjects: false, isEarlierNameCopyOnInOtherProjects: false },
  ])

  expect(line).toContain('from the project folder: claude plugin enable sidequest@eigenwise-toolshed --scope local; claude plugin enable live-rules@eigenwise-toolshed --scope local. Then remove')
})

const USER_SWITCHES_ON_THE_EARLIER_NAME = switchedKeys({ 'sidequest@toolshed-next': true })

test('the user settings switch on only the earlier-name copy, the shared-name copy is in this project only: the line adds the install that keeps the other projects', () => {
  const copies = [
    { marketplace: NEXT, scope: 'user' },
    { marketplace: SHARED, scope: 'project', projectPath: APP },
  ]
  const committed = switchedKeys({ 'sidequest@eigenwise-toolshed': true })
  const [doubled] = sidequestIn(copies, [committed, USER_SWITCHES_ON_THE_EARLIER_NAME], USER_SWITCHES_ON_THE_EARLIER_NAME)

  expect(doubled?.isOnlyEarlierNameCopyOnInOtherProjects).toBe(true)
  const line = installedTwiceLine(doubled === undefined ? [] : [doubled])
  expect(
    line.endsWith(
      "claude plugin uninstall sidequest@toolshed-next. Your other projects get sidequest from the toolshed-next copy. To keep it there, also run: claude plugin install sidequest@eigenwise-toolshed. A project where you switched the eigenwise-toolshed copy off itself stops running sidequest with this. Switch it on there, from that project's folder: claude plugin enable sidequest@eigenwise-toolshed --scope local.",
    ),
  ).toBe(true)
})

const BOTH_AT_USER_SCOPE = [
  { marketplace: NEXT, scope: 'user' },
  { marketplace: SHARED, scope: 'user' },
]

test('a shared-name copy the user settings switch on keeps the other projects, so no install is added', () => {
  const user = switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': true })
  const [doubled] = sidequestIn(BOTH_AT_USER_SCOPE, [user], user)

  expect(doubled?.isOnlyEarlierNameCopyOnInOtherProjects).toBe(false)
  expect(installedTwiceLine(doubled === undefined ? [] : [doubled])).not.toContain('claude plugin install')
})

// Built on a host with claude plugin disable: following the uninstall alone left the plugin off in every other project.
test('both copies at user scope and the shared-name one switched off there: the line adds the install, which switches it back on for every project', () => {
  const user = switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': false })
  const [doubled] = sidequestIn(BOTH_AT_USER_SCOPE, [user], user)

  expect(doubled?.isOnlyEarlierNameCopyOnInOtherProjects).toBe(true)
  const line = installedTwiceLine(doubled === undefined ? [] : [doubled])
  expect(line).toContain('claude plugin enable sidequest@eigenwise-toolshed --scope local. Then remove the toolshed-next copy: claude plugin uninstall sidequest@toolshed-next.')
  expect(
    line.endsWith(
      "To keep it there, also run: claude plugin install sidequest@eigenwise-toolshed. A project where you switched the eigenwise-toolshed copy off itself stops running sidequest with this. Switch it on there, from that project's folder: claude plugin enable sidequest@eigenwise-toolshed --scope local.",
    ),
  ).toBe(true)
})

// Built on a host with claude plugin disable: the other projects did not get the plugin, and the install would have switched it on in all of them.
test('the earlier-name copy at user scope switched off in the user settings: the other projects do not get it, so no install is added', () => {
  const copies = [
    { marketplace: NEXT, scope: 'user' },
    { marketplace: SHARED, scope: 'project', projectPath: APP },
  ]
  const user = switchedKeys({ 'sidequest@toolshed-next': false })
  const [doubled] = sidequestIn(copies, [switchedKeys({ 'sidequest@eigenwise-toolshed': true }), user], user)

  expect(doubled?.isOnlyEarlierNameCopyOnInOtherProjects).toBe(false)
  expect(installedTwiceLine(doubled === undefined ? [] : [doubled])).not.toContain('claude plugin install')
})

test('with no user settings read, nothing is said about other projects', () => {
  const [doubled] = sidequestIn(BOTH_AT_USER_SCOPE, [])

  expect(doubled?.isOnlyEarlierNameCopyOnInOtherProjects).toBe(false)
  expect(doubled?.isEarlierNameCopyOnInOtherProjects).toBe(false)
  expect(installedTwiceLine(doubled === undefined ? [] : [doubled])).not.toContain('A project where you switched')
})

// Built on a host: both copies at user scope and on, and a second project had switched the shared-name copy off for itself.
test('both copies switched on in the user settings: the line says what to do in a project that switched the shared-name copy off itself', () => {
  const user = switchedKeys({ 'sidequest@toolshed-next': true, 'sidequest@eigenwise-toolshed': true })
  const [doubled] = sidequestIn(BOTH_AT_USER_SCOPE, [user], user)

  expect(doubled?.isEarlierNameCopyOnInOtherProjects).toBe(true)
  const line = installedTwiceLine(doubled === undefined ? [] : [doubled])
  expect(line).not.toContain('To keep it there, also run')
  expect(
    line.endsWith(
      "claude plugin uninstall sidequest@toolshed-next. A project where you switched the eigenwise-toolshed copy off itself stops running sidequest with this. Switch it on there, from that project's folder: claude plugin enable sidequest@eigenwise-toolshed --scope local.",
    ),
  ).toBe(true)
})

test('an earlier-name copy that only this project has says nothing about other projects', () => {
  const copies = [
    { marketplace: NEXT, scope: 'local', projectPath: APP },
    { marketplace: SHARED, scope: 'user' },
  ]
  const user = switchedKeys({ 'sidequest@eigenwise-toolshed': true })
  const [doubled] = sidequestIn(copies, [switchedKeys({ 'sidequest@toolshed-next': true }), user], user)

  expect(doubled?.isEarlierNameCopyOnInOtherProjects).toBe(false)
  expect(installedTwiceLine(doubled === undefined ? [] : [doubled])).not.toContain('A project where you switched')
})
