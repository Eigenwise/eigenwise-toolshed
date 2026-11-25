import { isRecord } from './board-config'
import type { BoardFiles } from './store'

// Kept in the module, so a reload or a new session start says each of these once more.
const saidThisSession = new Set<string>()

export const BOARD_JSON_ON_READ = 'board.json on the first read'
export const BOARD_JSON_ON_WRITE = 'board.json on the first write'
export const VANISHED_BOARD = 'a board folder that is gone'

export const forgetNoticesSaid = (): void => saidThisSession.clear()

export const wasSaid = (key: string): boolean => saidThisSession.has(key)

export const sayOnce = (key: string, notice: string | undefined): string[] => {
  if (notice === undefined || saidThisSession.has(key)) return []
  saidThisSession.add(key)

  return [notice]
}

export const isBlank = (text: string | undefined): boolean => text === undefined || text.trim() === ''

const isJsonObject = (text: string): boolean => {
  try {
    return isRecord(JSON.parse(text))
  } catch {
    return false
  }
}

export const hasWorkOnDisk = (files: BoardFiles): boolean =>
  files.tickets.length + files.stories.length + (files.unusableFiles?.length ?? 0) > 0

// A missing or empty board.json holds nothing a person wrote, so the next write puts it back. A file that does not
// parse is theirs to fix, and is left byte for byte.
export const isBoardJsonBroken = (configText: string | undefined): boolean => !isBlank(configText) && !isJsonObject(configText ?? '')

const BROKEN_BOARD_JSON =
  '.sidequest/board.json is not valid JSON, so every setting is at its default until it is fixed. The board leaves the file as it is: fix it by hand.'

export const brokenBoardJsonNotice = (files: BoardFiles): string | undefined => (isBoardJsonBroken(files.configText) ? BROKEN_BOARD_JSON : undefined)

export const boardJsonWrittenAgainNotice = (prefix: string | undefined): string =>
  `.sidequest/board.json was missing or empty, so it was written again with the counters from the files on disk${prefix === undefined ? '' : ` and the prefix ${prefix} the tickets carry`}. Any settings it had are back at their defaults.`

export const VANISHED_BOARD_NOTICE =
  'A board was here: .git/info/exclude still lists .sidequest/, but the folder is gone (git clean -x or a delete removes it). It cannot be brought back from here. The next ticket starts a new board.'
