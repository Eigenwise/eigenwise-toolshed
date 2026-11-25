import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { boardCommand } from './board-command'
import { addAgentSpawn, addStep, addSubagentUsage, addToolCall, freshRecording, isPersonsOwnPrompt, notePrompt, tokensOf } from './ledger'
import { errorMessageOf, pinFailureStatus, recordMainTurn } from './session-ledger'
import { USAGE_PAGE_COMMAND, registerCommands, trackCommand } from './track-command'

const recording = atom({ plugin: 'observability', key: 'turn' } as const, freshRecording())

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommands($)
    const usage = await $.session.usage()
    await update($, recording, current => ({ ...current, costUsd: usage.cost?.usd ?? current.costUsd }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'track' }, ($, e) => trackCommand($, e.args)).catch(() => ({ text: 'observability: track failed' }))

  on('command.run', { command: USAGE_PAGE_COMMAND }, ($, e) => boardCommand($, e.origin)).catch(() => ({ text: 'observability: could not build the usage page' }))

  on('prompt.submit', async ($, e, next) => {
    if (isPersonsOwnPrompt(e)) await update($, recording, current => notePrompt(current, e.text.trim()))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const latencyMs = (await $.clock.now()) - startedAt
    await update($, recording, current => addStep(current, { model: e.model, latencyMs, usage: tokensOf(result.usage) }))
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    const durationMs = (await $.clock.now()) - startedAt
    const call = { tool: e.tool, durationMs, isError: result.isError === true, isDenied: result.deny !== undefined }
    await update($, recording, current => addToolCall(current, call))
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await update($, recording, current => addAgentSpawn(current, e.subagentType, result))
    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    await update($, recording, current => ({ ...current, compacted: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await update($, recording, current => addSubagentUsage(current, tokensOf(e.usage)))
    else await recordMainTurn($, e).catch((error: unknown) => pinFailureStatus($, `observability: could not write the ledger (${errorMessageOf(error)})`))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear starts a new task: its name and ticket come from the next prompt.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, recording, current => freshRecording(current.costUsd))
    return next(e)
  }).catch(($, e, next) => next(e))
}
