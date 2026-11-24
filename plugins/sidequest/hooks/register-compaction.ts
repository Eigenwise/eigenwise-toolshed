import { atom, read, update } from 'claude-code'
import type { EngineInterface, Frozen, On, PromptSubmitInput, SessionCompactInput, SessionCompactResult } from 'claude-code'

import { boardLocation } from './board-session'
import { afterCompactionLine } from './compaction-line'
import { firstPromptLine } from './first-prompt-line'
import { noteTurnPrompt } from './register-whose-words'
import { readBoard } from './store'
import { nobodyTypedLine } from './whose-words'

const firstPromptSession = atom({ plugin: 'sidequest', key: 'firstPromptSession' } as const, '')

// Kept in the module, not in state. A reload between the compaction and the next prompt loses it, and then the
// line never fires and nothing else breaks. A prompt costs two in-process calls (the stored session id and the
// current one) and no model tokens.
let compactedSinceLastPrompt = false

// Same trade as above: lost on a reload, and then the model simply is not told.
let rerouteLineForNextPrompt: string | undefined

export const rememberRerouteLine = (line: string): void => {
  rerouteLineForNextPrompt = line
}

// The tickets this session created, started or finished through the board's tools. Same trade again: after a reload
// it is empty, and the line after a compaction then names no counts.
const ticketsThisSessionTouched = new Set<string>()

export const rememberSessionWork = (ticketIds: readonly string[]): void => {
  for (const ticketId of ticketIds) ticketsThisSessionTouched.add(ticketId)
}

export const touchedThisSession = (): ReadonlySet<string> => ticketsThisSessionTouched

const withRerouteLine = (e: Frozen<PromptSubmitInput>): Frozen<PromptSubmitInput> => {
  if (e.command !== undefined) return e
  const line = rerouteLineForNextPrompt
  rerouteLineForNextPrompt = undefined

  return withContextLine(e, line)
}

const replacedMainConversation = (e: Frozen<SessionCompactInput>, compacted: SessionCompactResult): boolean =>
  e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined

// Keyed by session id, not by session.start: a reload fires session.start again, and /clear starts a new session id
// without firing it.
const firstPromptSeen = async ($: EngineInterface): Promise<boolean> => (await read($, firstPromptSession)) === (await $.session.id())

const rememberFirstPrompt = async ($: EngineInterface): Promise<void> => {
  const sessionId = await $.session.id()
  await update($, firstPromptSession, () => sessionId)
}

async function lineForThisBoard($: EngineInterface, compacted: boolean, firstPromptWasSeen: boolean): Promise<string | undefined> {
  const files = await readBoard($, await boardLocation($))
  const afterCompaction = compacted ? afterCompactionLine(files.tickets, files.stories, ticketsThisSessionTouched) : undefined

  return afterCompaction ?? (firstPromptWasSeen ? undefined : firstPromptLine(files.tickets))
}

const withContextLine = (e: Frozen<PromptSubmitInput>, line: string | undefined): Frozen<PromptSubmitInput> =>
  line === undefined ? e : { ...e, context: [...(e.context ?? []), line] }

// A slash command's own prompt is left alone, so the line rides the first prompt the model answers in words. A
// compaction that finds the board empty still leaves room for the session's first-prompt line.
async function withBoardLine($: EngineInterface, e: Frozen<PromptSubmitInput>): Promise<Frozen<PromptSubmitInput>> {
  if (e.command !== undefined) return e
  const firstPromptWasSeen = await firstPromptSeen($)
  if (firstPromptWasSeen && !compactedSinceLastPrompt) return e
  const compacted = compactedSinceLastPrompt
  compactedSinceLastPrompt = false
  await rememberFirstPrompt($)

  return withContextLine(e, await lineForThisBoard($, compacted, firstPromptWasSeen))
}

export const registerCompactionLine = (on: On): void => {
  // Nothing after next may throw: the .catch hands the compaction on again, and after a compaction that already ran
  // that would run a second one.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    compactedSinceLastPrompt ||= replacedMainConversation(e, compacted)

    return compacted
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const nobodyTyped = nobodyTypedLine(noteTurnPrompt(e))

    return next(withContextLine(withRerouteLine(await withBoardLine($, e)), nobodyTyped))
  }).catch(($, e, next) => next(e))
}
