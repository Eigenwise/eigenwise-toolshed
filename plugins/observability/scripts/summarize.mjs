#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configDirectoryOf } from './config-directory.mjs'

const GROUPINGS = ['day', 'model', 'category', 'ticket', 'routing']
const DEFAULT_ROW_LIMIT = 20
const UNATTRIBUTED = '(none or mixed)'

export function parseArguments(argumentList) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argumentList.length; index++) {
    if (argumentList[index].startsWith('--')) flags[argumentList[index].slice(2)] = argumentList[++index]
    else positional.push(argumentList[index])
  }
  return { target: positional[0], by: flags.by, since: flags.since, top: flags.top }
}

const problemWithGrouping = by => (by !== undefined && !GROUPINGS.includes(by) ? `--by takes one of: ${GROUPINGS.join(', ')}.` : undefined)

const problemWithSince = since => (since !== undefined && Number.isNaN(Date.parse(since)) ? '--since takes a date such as 2026-11-01.' : undefined)

const problemWithTop = top => (top !== undefined && !(Number.parseInt(top, 10) > 0) ? '--top takes a positive number.' : undefined)

export function problemWithArguments({ target, by, since, top }) {
  if (target === undefined) return 'Give a ledger file or a project path.'
  return problemWithGrouping(by) ?? problemWithSince(since) ?? problemWithTop(top)
}

// Same FNV-1a slug the recorder uses, so a project path finds its own ledger.
function pathHash(path) {
  let hash = 0x811c9dc5
  for (const character of path.replaceAll('\\', '/').toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

export function projectSlug(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const basename = (trimmed.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]/g, '_')
  return `${basename}-${pathHash(trimmed)}`
}

const present = value => (typeof value === 'string' && value !== '' ? value : undefined)

// The older plugin looked at HOME before USERPROFILE, so where the two differ its ledgers sit under HOME.
export function olderConfigDirectoryOf(environment, fallbackHome) {
  const home = present(environment.HOME) ?? present(environment.USERPROFILE) ?? present(fallbackHome)
  return present(environment.CLAUDE_CONFIG_DIR) ?? (home === undefined ? undefined : join(home, '.claude'))
}

/** Every folder a ledger of this machine may sit in: the one written now first, then the older plugin's when it differs. */
export function ledgerFoldersOf(environment, fallbackHome) {
  const configDirectories = [configDirectoryOf(environment, fallbackHome), olderConfigDirectoryOf(environment, fallbackHome)]
  const folders = configDirectories.filter(folder => folder !== undefined).map(folder => resolve(folder, 'observability', 'ledger'))
  return folders.filter((folder, index) => folders.findIndex(other => other.toLowerCase() === folder.toLowerCase()) === index)
}

const enclosingFolders = start => {
  const folders = [start]
  while (dirname(folders.at(-1)) !== folders.at(-1)) folders.push(dirname(folders.at(-1)))
  return folders
}

// The older plugin wrote <project>.jsonl and rolled a full one aside as <project>.<millis>.jsonl; this one writes
// <project>.<session>.jsonl per session and rolls those aside the same way. Every file with the project's prefix counts.
export function ledgerFilesFor(file) {
  const folder = dirname(file)
  const stem = file.slice(folder.length + 1).replace(/\.jsonl$/, '')
  const siblings = existsSync(folder) ? readdirSync(folder).filter(name => name.startsWith(`${stem}.`) && name.endsWith('.jsonl')) : []
  return [...new Set([file, ...siblings.map(name => join(folder, name))])].filter(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

const projectLedgerFiles = (projectFolder, ledgerFolders) =>
  ledgerFolders.flatMap(ledgerFolder => ledgerFilesFor(join(ledgerFolder, `${projectSlug(projectFolder)}.jsonl`)))

// A project path may be a subfolder of the project root, so each parent is tried until a ledger exists.
export function findLedgerFiles(target, ledgerFolders) {
  if (target.endsWith('.jsonl')) return ledgerFilesFor(resolve(target))
  for (const folder of enclosingFolders(resolve(target))) {
    const files = projectLedgerFiles(folder, ledgerFolders)
    if (files.length > 0) return files
  }
  return []
}

function parseRow(line) {
  try {
    const row = JSON.parse(line)
    return typeof row?.at === 'string' ? row : undefined
  } catch {
    return undefined
  }
}

export const readRows = files => files.flatMap(file => readFileSync(file, 'utf8').split('\n').map(parseRow).filter(row => row !== undefined))

const roundedDollars = usd => Math.round(usd * 1e6) / 1e6

const distinct = values => [...new Set(values.filter(value => value !== undefined))]

const soleValue = values => (distinct(values).length === 1 ? distinct(values)[0] : undefined)

const spawnsOf = row => row.spawns ?? []

export const turnTicket = row => row.ticket ?? soleValue(spawnsOf(row).map(spawn => spawn.ticket))

export const turnCategory = row => soleValue(spawnsOf(row).map(spawn => spawn.category))

const emptyBucket = key => ({ key, turns: 0, costUsd: 0, turnsWithoutCost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const tokensOf = (row, field) => row.usage?.[field] ?? 0

function addTurn(bucket, row) {
  bucket.turns += 1
  if (row.turnCostUsd === undefined) bucket.turnsWithoutCost += 1
  bucket.costUsd += row.turnCostUsd ?? 0
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) bucket[field] += tokensOf(row, field)
  return bucket
}

function groupTurns(rows, keyOf) {
  const buckets = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    buckets.set(key, addTurn(buckets.get(key) ?? emptyBucket(key), row))
  }
  return [...buckets.values()].map(bucket => ({ ...bucket, costUsd: roundedDollars(bucket.costUsd) })).sort((left, right) => right.costUsd - left.costUsd)
}

function addModelTally(buckets, model, tally) {
  const bucket = buckets.get(model) ?? { key: model, turns: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const field of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite']) bucket[field] += tally[field] ?? 0
  bucket.turns += 1
  buckets.set(model, bucket)
}

function tokensByModel(rows) {
  const buckets = new Map()
  for (const row of rows) for (const [model, tally] of Object.entries(row.models ?? {})) addModelTally(buckets, model, tally)
  return [...buckets.values()].sort((left, right) => right.requests - left.requests)
}

const isRouted = spawn => spawn.ticket !== undefined || spawn.category !== undefined

// A spawn whose model nobody recorded still shows in the counts, so the buckets add up to the spawns.
const UNKNOWN_MODEL = 'unknown'

function countOccurrence(counts, value) {
  if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1
}

function countSpawn(bucket, spawn) {
  bucket.spawns += 1
  countOccurrence(bucket.resolvedModels, spawn.resolvedModel ?? UNKNOWN_MODEL)
  countOccurrence(bucket.requestedModels, spawn.requestedModel ?? (isRouted(spawn) ? UNKNOWN_MODEL : undefined))
  countOccurrence(bucket.categories, spawn.category)
}

function spawnsByRouting(rows) {
  const emptyRoutingBucket = key => ({ key, spawns: 0, resolvedModels: {}, requestedModels: {}, categories: {} })
  const buckets = { routed: emptyRoutingBucket('routed'), unrouted: emptyRoutingBucket('unrouted') }
  for (const spawn of rows.flatMap(spawnsOf)) countSpawn(isRouted(spawn) ? buckets.routed : buckets.unrouted, spawn)
  return Object.values(buckets)
}

const BUCKETS = {
  day: rows => groupTurns(rows, row => row.at.slice(0, 10)),
  ticket: rows => groupTurns(rows, row => turnTicket(row) ?? UNATTRIBUTED),
  category: rows => groupTurns(rows, row => turnCategory(row) ?? UNATTRIBUTED),
  model: tokensByModel,
  routing: spawnsByRouting,
}

const turnTokens = row => Object.values(row.usage ?? {}).reduce((total, count) => total + count, 0)

function topTurns(rows) {
  return rows
    .filter(row => row.turnCostUsd !== undefined)
    .sort((left, right) => right.turnCostUsd - left.turnCostUsd)
    .map(row => ({ at: row.at, session: row.session, name: row.name, ticket: turnTicket(row), model: row.model, turnCostUsd: row.turnCostUsd, tokens: turnTokens(row) }))
}

function tableFor(rows, by) {
  if (by === undefined) return topTurns(rows)
  const table = BUCKETS[by](rows)
  return by === 'day' ? table.sort((left, right) => left.key.localeCompare(right.key)) : table
}

const notRecorded = reason => ({ recorded: false, reason })

const defaultLedgerFolders = () => ledgerFoldersOf(process.env, homedir())

const rowLimit = top => (top === undefined ? DEFAULT_ROW_LIMIT : Number.parseInt(top, 10))

function rowsSince(rows, since) {
  const sinceMs = since === undefined ? 0 : Date.parse(since)
  return rows.filter(row => Date.parse(row.at) >= sinceMs)
}

const sinceNote = since => (since === undefined ? '' : ` since ${since}`)

const placeLookedAt = (target, ledgerFolders) => (target.endsWith('.jsonl') ? resolve(target) : ledgerFolders.map(folder => join(folder, `${projectSlug(resolve(target))}.*.jsonl`)).join(' or '))

export function summarize(argumentList, ledgerFolders = defaultLedgerFolders()) {
  const options = parseArguments(argumentList)
  const problem = problemWithArguments(options)
  if (problem !== undefined) return { error: problem }
  const ledgerFiles = findLedgerFiles(options.target, ledgerFolders)
  const rows = rowsSince(readRows(ledgerFiles), options.since)
  if (rows.length === 0) {
    return notRecorded(`No turns recorded in ${placeLookedAt(options.target, ledgerFolders)}${sinceNote(options.since)}. Recording is off until /track on in the project.`)
  }
  const table = tableFor(rows, options.by).slice(0, rowLimit(options.top))
  return { recorded: true, ledgerFiles, turnsConsidered: rows.length, since: options.since, by: options.by ?? 'top turns by cost', table }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = summarize(process.argv.slice(2))
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.error === undefined ? 0 : 2
}
