import { configDirectoryOf } from './config-directory.mjs'
import type { HomeEnvironment } from './config-directory.mjs'

export type LedgerRow = { at: string } & Record<string, unknown>

const present = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value)

// The older plugin looked at HOME before USERPROFILE, so where the two differ its ledgers sit under HOME.
export function olderConfigDirectoryOf(environment: HomeEnvironment): string | undefined {
  const configured = present(environment.CLAUDE_CONFIG_DIR)
  if (configured !== undefined) return configured
  const home = present(environment.HOME) ?? present(environment.USERPROFILE)
  return home === undefined ? undefined : `${home}/.claude`
}

const comparable = (folder: string): string => folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const ledgerFolderOf = (configDirectory: string): string => `${configDirectory}/observability/ledger`

export const boardFileOf = (configDirectory: string): string => `${configDirectory}/observability/board.html`

/** Every folder a ledger of this machine may sit in: the one written now first, then the older plugin's when it differs. */
export function ledgerFoldersOf(environment: HomeEnvironment): string[] {
  const candidates = [configDirectoryOf(environment), olderConfigDirectoryOf(environment)].flatMap(folder => (folder === undefined ? [] : [folder]))
  const unique = candidates.filter((folder, index) => candidates.findIndex(other => comparable(other) === comparable(folder)) === index)
  return unique.map(ledgerFolderOf)
}

export const sessionLedgerFile = (folder: string, projectSlug: string, sessionId: string): string =>
  `${folder}/${projectSlug}.${sessionId.replace(/[^\w-]/g, '_')}.jsonl`

export const isLedgerFileName = (name: string): boolean => name.endsWith('.jsonl')

export const rolledAsideFile = (file: string, atMs: number): string => file.replace(/\.jsonl$/, `.${atMs}.jsonl`)

const isLedgerRow = (value: unknown): value is LedgerRow =>
  typeof value === 'object' && value !== null && 'at' in value && typeof value.at === 'string'

function parsedRow(line: string): LedgerRow | undefined {
  try {
    const row: unknown = JSON.parse(line)
    return isLedgerRow(row) ? row : undefined
  } catch {
    return undefined
  }
}

// A line that does not parse is a write cut short and is skipped.
export function rowsSince(text: string, sinceMs: number): LedgerRow[] {
  return text.split('\n').flatMap(line => {
    const row = parsedRow(line)
    return row !== undefined && Date.parse(row.at) >= sinceMs ? [row] : []
  })
}
