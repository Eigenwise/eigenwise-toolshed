import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findLedgerFiles, ledgerFoldersOf, parseArguments, problemWithArguments, projectSlug, summarize } from './summarize.mjs'

const scratchFolders = []

const scratchFolder = prefix => {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  scratchFolders.push(folder)
  return folder
}

// Thousands of these folders were found left in the temp folder: every run made some and nothing removed them.
after(() => scratchFolders.forEach(folder => rmSync(folder, { recursive: true, force: true })))

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ledger')
const FIXTURE_SLUG = 'demo-7b8bd8'
// What this repository's earlier 0.3.1 wrote: one file per session.
const SESSION_FIXTURE = join(FIXTURES, `${FIXTURE_SLUG}.session-1.jsonl`)
// What the older 1.1.1 wrote: one file per project, and the file it rolled aside at 3 MiB.
const OLDER_FIXTURES = [`${FIXTURE_SLUG}.jsonl`, `${FIXTURE_SLUG}.1762200000000.jsonl`]

const tableOf = (...argv) => summarize([SESSION_FIXTURE, ...argv]).table
const bucket = (table, key) => table.find(entry => entry.key === key)

// A project folder and a ledger folder holding the given fixtures, renamed to the project's own slug.
function projectWithLedgers(fixtureNames, ledgerFolder) {
  const projectRoot = join(scratchFolder('observability-'), 'work', 'demo')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  mkdirSync(ledgerFolder, { recursive: true })
  for (const name of fixtureNames) cpSync(join(FIXTURES, name), join(ledgerFolder, name.replace(FIXTURE_SLUG, projectSlug(projectRoot))))
  return projectRoot
}

test('cost and tokens by day, oldest first, skipping a line cut short', () => {
  const table = tableOf('--by', 'day')
  assert.deepEqual(table.map(entry => entry.key), ['2026-11-10', '2026-11-11', '2026-11-12'])
  assert.equal(bucket(table, '2026-11-10').costUsd, 3)
  assert.equal(bucket(table, '2026-11-10').cacheRead, 2000)
  assert.equal(bucket(table, '2026-11-12').turnsWithoutCost, 1)
  assert.equal(summarize([SESSION_FIXTURE]).turnsConsidered, 5)
})

test('--since drops earlier turns', () => {
  const result = summarize([SESSION_FIXTURE, '--by', 'day', '--since', '2026-11-11'])
  assert.deepEqual(result.table.map(entry => entry.key), ['2026-11-11', '2026-11-12'])
})

test('by model sums the engine tallies of each model', () => {
  const [opus] = tableOf('--by', 'model')
  assert.equal(opus.key, 'claude-opus')
  assert.equal(opus.requests, 10)
  assert.equal(opus.input, 500)
})

test('by ticket uses the prompt ticket, else the single ticket the turn spawned for', () => {
  const table = tableOf('--by', 'ticket')
  assert.equal(bucket(table, 'SQ-1').costUsd, 2)
  assert.equal(bucket(table, 'SQ-2').costUsd, 0.5)
  assert.equal(bucket(table, 'SQ-3').costUsd, 3)
  assert.equal(bucket(table, '(none or mixed)').turns, 2)
})

test('by category counts a turn once, under its only category', () => {
  const table = tableOf('--by', 'category')
  assert.equal(bucket(table, 'build').costUsd, 0.5)
  assert.equal(bucket(table, 'hard').costUsd, 3)
  assert.equal(bucket(table, '(none or mixed)').turns, 3)
})

test('routing separates routed from unrouted spawns by the model they ran on, with category and requested model', () => {
  const [routed, unrouted] = tableOf('--by', 'routing')
  assert.equal(routed.spawns, 4)
  assert.deepEqual(routed.resolvedModels, { 'claude-sonnet-5-5': 1, 'claude-opus': 2, 'claude-haiku': 1 })
  assert.deepEqual(routed.categories, { build: 1, hard: 2, quick: 1 })
  assert.deepEqual(routed.requestedModels, { sonnet: 1, opus: 1, unknown: 2 })
  assert.equal(unrouted.spawns, 1)
})

test('a spawn whose resolved model nobody recorded still counts, as unknown', () => {
  const ledgerFolder = join(scratchFolder('observability-'), 'ledger')
  const projectRoot = projectWithLedgers([], ledgerFolder)
  const row = { at: '2026-11-18T10:00:00.000Z', turnCostUsd: 0, usage: {}, spawns: [{ category: 'build' }, {}] }
  writeFileSync(join(ledgerFolder, `${projectSlug(projectRoot)}.session-one.jsonl`), `${JSON.stringify(row)}\n`)
  const [routed, unrouted] = summarize([projectRoot, '--by', 'routing'], [ledgerFolder]).table
  assert.deepEqual(routed.resolvedModels, { unknown: 1 })
  assert.deepEqual(unrouted.resolvedModels, { unknown: 1 })
  assert.deepEqual(unrouted.requestedModels, {})
})

test('without --by it lists the costliest turns, bounded by --top', () => {
  const table = tableOf('--top', '2')
  assert.deepEqual(table.map(entry => entry.turnCostUsd), [3, 2])
  assert.equal(table[0].tokens, 1160)
})

test('an empty or missing ledger says not recorded and how recording starts', () => {
  const missing = summarize([join(tmpdir(), 'nothing-here.jsonl'), '--by', 'day'])
  assert.equal(missing.recorded, false)
  assert.match(missing.reason, /off until \/track on in the project/)
  assert.equal(summarize([SESSION_FIXTURE, '--since', '2027-01-01']).recorded, false)
  const ledgerFolder = join(scratchFolder('observability-'), 'ledger')
  const projectRoot = projectWithLedgers([], ledgerFolder)
  assert.equal(summarize([projectRoot], [ledgerFolder]).recorded, false)
})

test('the ledgers the older plugin wrote and the per-session ones are all read, from the root or a subfolder', () => {
  const ledgerFolder = join(scratchFolder('observability-'), 'ledger')
  const projectRoot = projectWithLedgers([...OLDER_FIXTURES, `${FIXTURE_SLUG}.session-1.jsonl`], ledgerFolder)

  const result = summarize([projectRoot], [ledgerFolder])
  assert.equal(result.ledgerFiles.length, 3)
  assert.equal(result.turnsConsidered, 5 + 2 + 1)
  assert.equal(summarize([join(projectRoot, 'src')], [ledgerFolder]).turnsConsidered, 8)
  assert.deepEqual(findLedgerFiles(join(projectRoot, 'src'), [ledgerFolder]).sort(), readdirSync(ledgerFolder).map(name => join(ledgerFolder, name)).sort())
})

test('a ledger of the older plugin alone is read, rolled-aside file included, and its quality field is ignored', () => {
  const ledgerFolder = join(scratchFolder('observability-'), 'ledger')
  const projectRoot = projectWithLedgers(OLDER_FIXTURES, ledgerFolder)

  const byTicket = summarize([projectRoot, '--by', 'ticket'], [ledgerFolder])
  assert.equal(byTicket.turnsConsidered, 3)
  assert.equal(bucket(byTicket.table, 'PL-7').costUsd, 0.4)
  assert.equal(JSON.stringify(byTicket).includes('ccMax'), false)
  assert.deepEqual(summarize([projectRoot, '--by', 'day'], [ledgerFolder]).table.map(entry => entry.key), ['2026-11-01', '2026-11-05'])
})

test('two sessions in one project are both read', () => {
  const ledgerFolder = join(scratchFolder('observability-'), 'ledger')
  const projectRoot = projectWithLedgers([], ledgerFolder)
  const row = `${JSON.stringify({ at: '2026-10-01T00:00:00.000Z', turnCostUsd: 1, usage: {} })}\n`
  writeFileSync(join(ledgerFolder, `${projectSlug(projectRoot)}.session-a.jsonl`), row)
  writeFileSync(join(ledgerFolder, `${projectSlug(projectRoot)}.session-b.jsonl`), row)

  assert.equal(summarize([projectRoot], [ledgerFolder]).turnsConsidered, 2)
})

test('where HOME and USERPROFILE differ, both config folders are looked in, the one written now first', () => {
  const folders = ledgerFoldersOf({ HOME: '/home-folder', USERPROFILE: '/profile-folder' })
  assert.deepEqual(folders, [resolve('/profile-folder/.claude/observability/ledger'), resolve('/home-folder/.claude/observability/ledger')])
  assert.equal(ledgerFoldersOf({ HOME: '/same', USERPROFILE: '/same' }).length, 1)
  assert.deepEqual(ledgerFoldersOf({ CLAUDE_CONFIG_DIR: '/configured', HOME: '/home-folder', USERPROFILE: '/profile-folder' }), [resolve('/configured/observability/ledger')])
})

test('a ledger the older plugin placed under HOME is found when USERPROFILE points elsewhere', () => {
  const machine = scratchFolder('observability-')
  const environment = { HOME: join(machine, 'home'), USERPROFILE: join(machine, 'profile') }
  const olderLedgerFolder = join(environment.HOME, '.claude', 'observability', 'ledger')
  const projectRoot = projectWithLedgers(OLDER_FIXTURES, olderLedgerFolder)

  const result = summarize([projectRoot], ledgerFoldersOf(environment))
  assert.equal(result.recorded, true)
  assert.equal(result.turnsConsidered, 3)
})

test('the slug matches the one the recorder writes', () => {
  assert.equal(projectSlug('/work/demo'), 'demo-7b8bd8')
})

test('bad arguments are named, not guessed', () => {
  assert.match(problemWithArguments(parseArguments([])), /ledger file or a project path/)
  assert.match(problemWithArguments(parseArguments([SESSION_FIXTURE, '--by', 'color'])), /--by takes/)
  assert.match(problemWithArguments(parseArguments([SESSION_FIXTURE, '--since', 'lately'])), /--since takes/)
  assert.match(problemWithArguments(parseArguments([SESSION_FIXTURE, '--top', '0'])), /--top takes/)
  assert.equal(summarize([SESSION_FIXTURE, '--top', 'x']).error !== undefined, true)
})
