import type { EngineInterface, PromptOrigin } from 'claude-code'

import { boardHtml } from '../scripts/board-page.mjs'
import { configDirectoryOf } from './config-directory.mjs'
import { boardFileOf, isLedgerFileName, ledgerFoldersOf, rowsSince } from './ledger-files'
import type { LedgerRow } from './ledger-files'
import { boardWrittenText } from './recording-switch'
import { homeEnvironmentOf } from './session-ledger'

// The board's longest period, as on the older board; older rows stay in the ledger for the text report.
const BOARD_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

async function ledgerFilesIn($: EngineInterface, folder: string): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  return entries.filter(entry => entry.kind === 'file' && isLedgerFileName(entry.name)).map(entry => `${folder}/${entry.name}`)
}

function readOrEmpty($: EngineInterface, file: string): Promise<string> {
  return $.fs.read(file).catch(() => '')
}

// Every project's ledgers of the last 90 days, rolled-aside ones and the older plugin's included.
async function recentRows($: EngineInterface, folders: readonly string[], sinceMs: number): Promise<LedgerRow[]> {
  const files = (await Promise.all(folders.map(folder => ledgerFilesIn($, folder)))).flat()
  const texts = await Promise.all(files.map(file => readOrEmpty($, file)))
  return texts.flatMap(text => rowsSince(text, sinceMs))
}

async function openFile($: EngineInterface, file: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  if (isWindows) {
    await $.process.run(['cmd', '/c', 'start', '', file.replace(/\//g, '\\')])
    return
  }
  const isMac = (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run([isMac ? 'open' : 'xdg-open', file])
}

// Only a command typed at this terminal has someone at this screen. From a phone, a script or another plugin the
// page is written and not opened, or it would open on a desk nobody is at.
const ORIGINS_AT_THIS_SCREEN: ReadonlySet<PromptOrigin['kind']> = new Set(['composer'])

const isAtThisScreen = (origin: PromptOrigin): boolean => ORIGINS_AT_THIS_SCREEN.has(origin.kind)

/** Writes the board in one whole write, from the command only, so no run ever leaves a page half written. */
export async function boardCommand($: EngineInterface, origin: PromptOrigin): Promise<{ text: string }> {
  const environment = await homeEnvironmentOf($)
  const configDirectory = configDirectoryOf(environment)
  if (configDirectory === undefined) return { text: 'observability: no config or home folder found, so there is no usage page' }
  const now = await $.clock.now()
  const rows = await recentRows($, ledgerFoldersOf(environment), now - BOARD_DAYS * DAY_MS)
  const file = boardFileOf(configDirectory)
  await $.fs.write(file, boardHtml(rows, now))
  const atThisScreen = isAtThisScreen(origin)
  if (atThisScreen) await openFile($, file)
  return { text: boardWrittenText(file, atThisScreen) }
}
