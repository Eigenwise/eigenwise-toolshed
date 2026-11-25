import { expect, test } from 'claude-code/testing'

import {
  displayedPath,
  gatewayLine,
  plainLines,
  quartermasterLines,
  installedEntriesOf,
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
