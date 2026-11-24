import type { EngineInterface, Hook, On, Register, ToolCallResult } from 'claude-code'

import { causeOf, evidenceToolRefusal, ownToolRefusal } from './failure-cause'
import { denialEvent, toolCallEvents, typedBashCommand, typedShellEvents } from './sensing'
import type { PermissionVerdict } from './sensing'
import type { SensedEvent } from './events'
import { SessionMemory, eventsDirectoryFor, impressionsPathFor } from './session-memory'
import type { Published } from './session-memory'
import { answerEvidence } from './evidence-tool'
import { runProposalOperation } from './proposal-tool'
import type { ToolAnswer } from './proposal-tool'
import { EVIDENCE_TOOL, PROPOSAL_TOOL } from './tool-specs'
import { forgetStoredProposals } from './store'
import type { FileSystem } from './store'
import { homeOf } from './home'
import { stringField } from './tool-input'
import type { ToolInput } from './tool-input'
import { logIgnoredOffer, offerAtPause, registerViews, startInbox } from './views/register-views'

let memory: Promise<SessionMemory> | undefined

const filesOf = ($: EngineInterface): FileSystem => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  exists: path => $.fs.exists(path),
  list: path => $.fs.list(path),
})

const userSkillsOf = async ($: EngineInterface): Promise<string[]> =>
  (await $.command.list().catch(() => [])).filter(command => command.source === 'user').map(command => command.name)

const openMemory = async ($: EngineInterface, cwd: string): Promise<SessionMemory> => {
  const session = new SessionMemory(filesOf($), cwd, eventsDirectoryFor(await homeOf($), cwd), await userSkillsOf($), (await $.clock.now()).toString(36))
  await session.load(await $.clock.now())

  return session
}

/** A failed load is forgotten, so the next hook tries again instead of awaiting the same rejection all session. */
const remember = (opening: Promise<SessionMemory>): Promise<SessionMemory> => {
  memory = opening.catch((error: unknown) => {
    memory = undefined
    throw error
  })

  return memory
}

const memoryOf = ($: EngineInterface): Promise<SessionMemory> =>
  memory ?? remember($.session.cwd().then(cwd => openMemory($, cwd)))

const publish = async ($: EngineInterface, published: Published): Promise<void> => {
  await $.state.set({ plugin: 'quartermaster', key: 'inbox' } as const, { waiting: published.waiting })
  await $.state.set({ plugin: 'quartermaster', key: 'candidates' } as const, published.candidates)
}

const isoNow = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

const sense = async ($: EngineInterface, events: readonly SensedEvent[]): Promise<void> => {
  ;(await memoryOf($)).buffer.add(events)
}

const outcomeOf = (call: { tool: string; command?: unknown }, result: ToolCallResult) => ({
  tool: call.tool,
  command: call.command,
  isError: result.isError === true,
  errorText: result.text ?? '',
})

type Denial = { deny: string }

const toolInputOf = (call: Readonly<Record<string, unknown>>): ToolInput => call

const ownToolFailure = (text: string, cause?: string): Denial => ({ deny: ownToolRefusal(text, cause) })

// The loaded memory knows where events really went, including after a failed home write moved them to the project.
// Without one, or when working it out throws, the message goes out without a folder rather than not at all.
const eventsFolderOf = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const loaded = await memory?.catch(() => undefined)

    return loaded?.eventsDirectory ?? eventsDirectoryFor(await homeOf($), await $.session.cwd())
  } catch {
    return undefined
  }
}

const evidenceToolFailure = async ($: EngineInterface, cause: string): Promise<Denial> => ({
  deny: evidenceToolRefusal(await eventsFolderOf($), cause),
})

// The host takes a string or content blocks as a tool result, so the model gets the answer's text.
const hostResultOf = (answer: ToolAnswer): ToolCallResult => ('deny' in answer ? answer : { result: answer.text })

const SUBAGENT_WRITE = ownToolFailure('a subagent cannot write proposals; return the draft to the main session, which writes it')

const startSession: Hook<'session.start'> = async ($, e, next) => {
  forgetStoredProposals()
  countedRows.clear()
  verdictsByCall.clear()
  await $.tool.register(EVIDENCE_TOOL)
  await $.tool.register(PROPOSAL_TOOL)
  const session = await remember(openMemory($, e.cwd))
  await publish($, await session.published(await $.clock.now()))
  await startInbox($)

  return next(e)
}

const verdictsByCall = new Map<string, PermissionVerdict>()

const senseToolCall: Hook<'tool.call'> = async ($, e, next) => {
  const result = await next(e)
  const session = await memoryOf($)
  const outcome = outcomeOf({ tool: e.tool, command: 'command' in e ? e.command : undefined }, result)
  session.buffer.add(toolCallEvents(outcome, await isoNow($), verdictsByCall.get(e.tool_use_id)))
  if (e.agentId === undefined) session.buffer.countToolCall()

  return result
}

const countedRows = new Set<string>()

const typedCommandOf = (e: Parameters<Hook<'session.append'>>[1]): string | undefined =>
  e.agentId === undefined && e.message.type === 'user' && !countedRows.has(e.uuid)
    ? typedBashCommand(e.message.content)
    : undefined

/** A resumed session may raise restored rows again, so each row is counted once. */
const senseTypedShell: Hook<'session.append'> = async ($, e, next) => {
  const command = typedCommandOf(e)
  if (command !== undefined) {
    countedRows.add(e.uuid)
    await sense($, typedShellEvents(command, await isoNow($)))
  }

  return next(e)
}

const senseRuleDenial: Hook<'tool.check'> = async ($, e, next) => {
  const verdict = await next(e)
  if (e.tool_use_id === undefined) return verdict
  if (verdict.decision === 'deny') {
    verdictsByCall.set(e.tool_use_id, 'denied')
    await sense($, [denialEvent(e.tool, e.input, await isoNow($))])
  } else if (verdict.decision === 'ask' && e.approver === undefined) {
    verdictsByCall.set(e.tool_use_id, 'nobody-to-ask')
  }

  return verdict
}

const senseClassifierDenial: Hook<'classic.PermissionDenied'> = async ($, e, next) => {
  verdictsByCall.set(e.tool_use_id, 'denied')
  await sense($, [denialEvent(e.tool_name, e.tool_input, await isoNow($))])

  return next(e)
}

const senseSkill: Hook<'skill.prompt'> = async ($, e, next) => {
  await sense($, [{ kind: 'skill', at: await isoNow($), skill: e.skill }])

  return next(e)
}

const senseCompaction: Hook<'session.compact'> = async ($, e, next) => {
  await sense($, [{ kind: 'compaction', at: await isoNow($), trigger: String(e.trigger) }])

  return next(e)
}

const eventsNotSavedStatus = (session: SessionMemory, error: string | undefined): string | undefined =>
  error === undefined
    ? undefined
    : `Quartermaster could not save to ${session.eventsDirectory} (${error}), so it saves in this project instead: .claude/quartermaster/events/`

/** A compaction or denial after the last turn would otherwise die with the process. */
const flushPending = async ($: EngineInterface): Promise<void> => {
  const session = await memoryOf($)
  const pending = session.buffer.drain()
  if (pending.length > 0) await session.flush(pending, await $.clock.now())
}

const endSession: Hook<'session.end'> = async ($, e, next) => {
  await flushPending($).catch(() => undefined)
  await logIgnoredOffer($)

  return next(e)
}

const flushTurn: Hook<'turn.complete'> = async ($, e, next) => {
  const result = await next(e)
  if (e.agentId !== undefined) return result
  const session = await memoryOf($)
  const now = await $.clock.now()
  const error = await session.flush(session.buffer.closeTurn(e.durationMs, new Date(now).toISOString()), now)
  await publish($, await session.published(now))
  await offerAtPause($, e, eventsNotSavedStatus(session, error))

  return result
}

/**
 * Sensing, the two tools and the published state. Views add their hooks next
 * to this call. Every sensing hook passes its result through untouched and,
 * when it breaks, steps aside.
 */
export const registerCore = (on: On): void => {
  on('session.start', startSession).catch(($, e, next) => next(e))
  on('tool.call', senseToolCall).catch(($, e, next) => next(e))
  on('session.append', { door: 'command' }, senseTypedShell).catch(($, e, next) => next(e))
  on('tool.check', senseRuleDenial).catch(($, e, next) => next(e))
  on('classic.PermissionDenied', senseClassifierDenial).catch(($, e, next) => next(e))
  on('skill.prompt', senseSkill).catch(($, e, next) => next(e))
  on('session.compact', senseCompaction).catch(($, e, next) => next(e))
  on('session.end', endSession).catch(($, e, next) => next(e))
  on('turn.complete', flushTurn).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__quartermaster__evidence' }, async ($, e) => {
    const session = await memoryOf($)
    const sources = { ...session.sources(await $.clock.now()), pending: session.buffer.pending() }

    return hostResultOf(await answerEvidence(sources, stringField(toolInputOf(e), 'since')))
  }).catch(async ($, e, next) => evidenceToolFailure($, causeOf(next.error)))

  on('tool.call', { tool: 'mcp__quartermaster__proposal' }, async ($, e) => {
    const input = toolInputOf(e)
    if (e.agentId !== undefined && stringField(input, 'operation') !== 'list') return SUBAGENT_WRITE
    const session = await memoryOf($)
    const now = await $.clock.now()
    const answer = await runProposalOperation(input, {
      files: session.files,
      cwd: session.cwd,
      impressionsPath: impressionsPathFor(await homeOf($), session.cwd),
      now,
    })
    await publish($, await session.refreshRejections(now))

    return hostResultOf(answer)
  }).catch(($, e, next) => ownToolFailure('the proposal tool failed; edit the proposal file directly', causeOf(next.error)))
}

export const register: Register = on => {
  registerCore(on)
  registerViews(on)
}
