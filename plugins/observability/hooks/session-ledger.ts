import { atom, update } from 'claude-code'
import type { EngineInterface, TurnCompleteInput } from 'claude-code'

import type { HomeEnvironment } from './config-directory.mjs'
import { configDirectoryOf } from './config-directory.mjs'
import { appendLine, carryOverIntoNextTurn, foldTurn, freshRecording, projectSlug, tokensOf } from './ledger'
import type { TurnEnd, TurnRow } from './ledger'
import { ledgerFolderOf, rolledAsideFile, sessionLedgerFile } from './ledger-files'
import { switchKeyOf } from './recording-switch'

// $.fs.read refuses files over 4 MiB, so a ledger is rolled aside well before that.
const LEDGER_CAP_BYTES = 3 * 1024 * 1024
const byteLength = (text: string) => new TextEncoder().encode(text).length

// The same state as register.tsx's: the host follows a state only where it is declared in the file using it.
const recording = atom({ plugin: 'observability', key: 'turn' } as const, freshRecording())
const sidequestRuns = { plugin: 'sidequest', key: 'runs' } as const

export type Project = { root: string; slug: string }

export async function readProject($: EngineInterface): Promise<Project> {
  const repository = await $.session.repo().catch(() => null)
  const root = repository?.root ?? (await $.session.cwd())
  return { root, slug: projectSlug(root) }
}

export async function isRecording($: EngineInterface, project: Project): Promise<boolean> {
  return (await $.store.get(switchKeyOf(project.root))) === true
}

export function setRecording($: EngineInterface, project: Project, isOn: boolean): Promise<void> {
  return $.store.set(switchKeyOf(project.root), isOn)
}

export async function homeEnvironmentOf($: EngineInterface): Promise<HomeEnvironment> {
  const [CLAUDE_CONFIG_DIR, HOME, USERPROFILE] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')])
  return { CLAUDE_CONFIG_DIR, HOME, USERPROFILE }
}

export async function configDirectoryOfSession($: EngineInterface): Promise<string | undefined> {
  return configDirectoryOf(await homeEnvironmentOf($))
}

// Each session writes its own file, so two sessions in one project never rewrite each other's rows.
export async function ledgerFileOf($: EngineInterface, project: Project): Promise<string | undefined> {
  const configDirectory = await configDirectoryOfSession($)
  return configDirectory === undefined ? undefined : sessionLedgerFile(ledgerFolderOf(configDirectory), project.slug, await $.session.id())
}

// The host has no append call, so a turn reads its own session's file and writes it back whole.
async function appendRow($: EngineInterface, file: string, row: TurnRow): Promise<void> {
  const existing = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
  if (byteLength(existing) < LEDGER_CAP_BYTES) return $.fs.write(file, appendLine(existing, row))
  await $.fs.write(rolledAsideFile(file, Date.parse(row.at)), existing)
  await $.fs.write(file, appendLine('', row))
}

async function describeTurnEnd($: EngineInterface, project: Project, event: TurnCompleteInput): Promise<TurnEnd> {
  const sessionUsage = await $.session.usage()
  return {
    at: new Date(await $.clock.now()).toISOString(),
    project: project.slug,
    session: await $.session.id(),
    startedAt: sessionUsage.startedAt,
    turn: await $.session.turns(),
    reason: event.reason,
    durationMs: event.durationMs,
    usage: tokensOf(event.usage),
    sessionUsage,
    model: await $.session.model(),
    version: (await $.session.version()).version,
  }
}

// A status line is one row: 300 characters is more than any terminal shows of it and keeps a long stack out of it.
const MAX_CAUSE_CHARACTERS = 300
export const errorMessageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_CAUSE_CHARACTERS)

// Only a status this plugin pinned is cleared, so a good write costs no host call while nothing is wrong.
let isFailureStatusPinned = false

export function pinFailureStatus($: EngineInterface, text: string): void {
  isFailureStatusPinned = true
  $.ui.status(text)
}

export async function clearFailureStatus($: EngineInterface): Promise<void> {
  if (!isFailureStatusPinned) return
  isFailureStatusPinned = false
  await $.ui.status(undefined)
}

async function writeRow($: EngineInterface, project: Project, row: TurnRow): Promise<void> {
  const file = await ledgerFileOf($, project)
  if (file === undefined) return pinFailureStatus($, 'observability: no config or home folder found, so the turn was not recorded')
  await appendRow($, file, row)
  await clearFailureStatus($)
}

/** Folds the finished main turn into a row, carries the name and cost baseline on, and writes the row when the project records. */
export async function recordMainTurn($: EngineInterface, event: TurnCompleteInput): Promise<void> {
  const project = await readProject($)
  const wantsRow = await isRecording($, project)
  const end = await describeTurnEnd($, project, event)
  const runs = wantsRow ? (await $.state.get(sidequestRuns)).value : undefined
  let row: TurnRow | undefined
  await update($, recording, current => {
    row = foldTurn(current, end, runs)
    return carryOverIntoNextTurn(current, row.costUsd)
  })
  if (wantsRow && row !== undefined) await writeRow($, project, row)
}
