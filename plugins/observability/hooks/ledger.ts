import type { AgentSpawnResult, ModelUsage, PromptOrigin, PromptSubmitInput, SessionUsage, TurnCompleteReason } from 'claude-code'

import type { ModelTally, Recording, RoutedRun, SpawnRow, SpawnStart, Tokens, ToolTally } from '../types'
import { joinSpawns } from './spawns'

// Version 1 since the first ledger: rows the older plugin wrote read the same, and a `quality` field it may carry is never read.
export type TurnRow = {
  v: 1
  at: string
  project: string
  session: string
  startedAt: number
  name: string
  turn: number
  reason: TurnCompleteReason
  durationMs: number
  costUsd?: number
  turnCostUsd?: number
  model: string
  usage: Tokens
  models: Record<string, ModelTally>
  tools: Record<string, ToolTally>
  agents: Record<string, number>
  spawns?: SpawnRow[]
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  compacted: boolean
  ticket?: string
  version: string
}

export type TurnEnd = {
  at: string
  project: string
  session: string
  startedAt: number
  turn: number
  reason: TurnCompleteReason
  durationMs: number
  usage: Tokens
  sessionUsage: SessionUsage
  model: string
  version: string
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const tokensOf = (usage: ModelUsage | null | undefined): Tokens =>
  usage
    ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
    : NO_TOKENS

export const addTokens = (first: Tokens, second: Tokens): Tokens => ({
  input: first.input + second.input,
  output: first.output + second.output,
  cacheRead: first.cacheRead + second.cacheRead,
  cacheWrite: first.cacheWrite + second.cacheWrite,
})

export const freshRecording = (costUsd = 0): Recording => ({
  name: '',
  costUsd,
  subagentUsage: NO_TOKENS,
  models: {},
  tools: {},
  agents: {},
  spawns: [],
  compacted: false,
})

export const carryOverIntoNextTurn = (recording: Recording, costUsd: number | undefined): Recording => ({
  ...freshRecording(costUsd ?? recording.costUsd),
  name: recording.name,
})

export function addStep(recording: Recording, step: { model: string; latencyMs: number; usage: Tokens }): Recording {
  const before = recording.models[step.model] ?? { ...NO_TOKENS, requests: 0, latencyMs: 0 }
  const after = { ...addTokens(before, step.usage), requests: before.requests + 1, latencyMs: before.latencyMs + step.latencyMs }
  return { ...recording, models: { ...recording.models, [step.model]: after } }
}

export function addToolCall(recording: Recording, call: { tool: string; durationMs: number; isError: boolean; isDenied: boolean }): Recording {
  const before = recording.tools[call.tool] ?? { calls: 0, errors: 0, denies: 0, ms: 0 }
  const after = {
    calls: before.calls + 1,
    errors: before.errors + Number(call.isError),
    denies: before.denies + Number(call.isDenied),
    ms: before.ms + call.durationMs,
  }
  return { ...recording, tools: { ...recording.tools, [call.tool]: after } }
}

export function addAgentSpawn(recording: Recording, agentType: string, result: AgentSpawnResult): Recording {
  if (result.deny !== undefined) return recording
  const started: SpawnStart[] = result.agentId === undefined ? [] : [{ agentId: result.agentId, agentType, resolvedModel: result.model }]
  return {
    ...recording,
    agents: { ...recording.agents, [agentType]: (recording.agents[agentType] ?? 0) + 1 },
    spawns: [...recording.spawns, ...started],
  }
}

export const addSubagentUsage = (recording: Recording, usage: Tokens): Recording => ({
  ...recording,
  subagentUsage: addTokens(recording.subagentUsage, usage),
})

const toMicroDollars = (usd: number) => Math.round(usd * 1e6) / 1e6

// A cost below the baseline means the engine started its ledger over.
export const turnCostSince = (baseline: number, costUsd: number | undefined): number | undefined => {
  if (costUsd === undefined) return undefined
  return toMicroDollars(costUsd >= baseline ? costUsd - baseline : costUsd)
}

export function foldTurn(recording: Recording, end: TurnEnd, runs?: Record<string, RoutedRun>): TurnRow {
  const { cost, context, rateLimits } = end.sessionUsage
  return {
    v: 1,
    at: end.at,
    project: end.project,
    session: end.session,
    startedAt: end.startedAt,
    name: recording.name,
    turn: end.turn,
    reason: end.reason,
    durationMs: end.durationMs,
    costUsd: cost?.usd,
    turnCostUsd: turnCostSince(recording.costUsd, cost?.usd),
    model: end.model,
    usage: addTokens(end.usage, recording.subagentUsage),
    models: recording.models,
    tools: recording.tools,
    agents: recording.agents,
    spawns: joinSpawns(recording.spawns, runs),
    context: { tokens: context.tokens, window: context.window, percent: context.percent },
    rateLimits: rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
    compacted: recording.compacted,
    ticket: recording.ticket,
    version: end.version,
  }
}

// Read the way Sidequest routes: a ref counts only where a brief puts it, at the start. A ref further in is a mention.
// A board picks its own one to ten capital letters, and this plugin stays apart from Sidequest, so it reads the shape.
// A story id like PL-S3 has a letter after the dash, so it never reads as a ticket.
const LEADING_TICKET_REFERENCE = /^\s*(?:Ticket\s+)?([A-Z]{1,10}-\d+)\b/

export const ticketRef = (text: string): string | undefined => LEADING_TICKET_REFERENCE.exec(text)?.[1]

export const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, 60)

// The person's own words: typed at the terminal, sent from their phone, or given to `claude -p`.
// Another session's message, a task notification, a schedule or a plugin never names the session.
const PERSON_TYPED_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge', 'sdk'])

const isTypedByThePerson = (origin: PromptOrigin): boolean => PERSON_TYPED_ORIGINS.has(origin.kind)

// A slash command and a prompt the person never saw as typed name nothing either.
export const isPersonsOwnPrompt = (prompt: PromptSubmitInput): boolean =>
  isTypedByThePerson(prompt.origin) && prompt.command === undefined && prompt.isMeta !== true && prompt.text.trim() !== ''

export function notePrompt(recording: Recording, text: string): Recording {
  const ticket = ticketRef(text)
  return { ...recording, name: recording.name || firstLine(text), ...(ticket ? { ticket } : {}) }
}

// FNV-1a over the whole path: two projects named `app` in different folders get different ledgers.
// The module has no node:crypto, and six hex digits are plenty for one machine's projects.
const pathHash = (path: string): string => {
  let hash = 0x811c9dc5
  for (const character of path.replace(/\\/g, '/').toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

export const projectSlug = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const basename = (trimmed.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]/g, '_')
  return `${basename}-${pathHash(trimmed)}`
}

export const appendLine = (existing: string, row: TurnRow): string =>
  `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${JSON.stringify(row)}\n`
