import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { BoardLocation } from './store'
import { TIDY_REQUEST_LINE, hasManyWorktrees, linkedWorktreeCount, worktreeToast, worktreesFolderOf } from './worktree-count'

const worktreeCount = atom({ plugin: 'sidequest', key: 'worktreeCount' } as const, 0)
const worktreeToastSession = atom({ plugin: 'sidequest', key: 'worktreeToastSession' } as const, '')

async function countLinkedWorktrees($: EngineInterface, location: BoardLocation): Promise<number> {
  if (location.gitCommonDir === undefined) return 0
  const entries = await $.fs.list(worktreesFolderOf(location.gitCommonDir)).catch(() => [])

  return linkedWorktreeCount(entries)
}

// Keyed by session id, not by session.start: a reload fires session.start again.
async function toastOncePerSession($: EngineInterface, count: number): Promise<void> {
  if (!hasManyWorktrees(count)) return
  const sessionId = await $.session.id()
  if ((await read($, worktreeToastSession)) === sessionId) return
  await update($, worktreeToastSession, () => sessionId)
  $.ui.toast(worktreeToast(count))
}

export async function senseWorktrees($: EngineInterface, location: BoardLocation): Promise<void> {
  const count = await countLinkedWorktrees($, location)
  await update($, worktreeCount, () => count)
  await toastOncePerSession($, count)
}

// One model turn, on the person's press, the same as typing it.
export async function askForTidy($: EngineInterface): Promise<void> {
  const entered = await $.prompt.submit({ text: TIDY_REQUEST_LINE, asUser: true })
  if (entered.drop !== undefined) $.ui.toast(`The session did not take it: ${entered.drop}. Ask for the tidy skill in the chat.`)
}
