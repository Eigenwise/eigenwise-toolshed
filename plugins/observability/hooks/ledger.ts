import type { ModelUsage, SessionUsage, TurnCompleteReason } from 'claude-code'

import type { ModelTally, QualityMeasurement, Recording, Tokens, ToolTally, TurnQuality } from '../types'

export type TurnRow = {
  v: 1
  quality?: TurnQuality
  at: string
  project: string
  session: string
  startedAt: number
  name: string
  turn: number
  reason: TurnCompleteReason
  durationMs: number
  costUsd: number
  turnCostUsd: number
  model: string
  usage: Tokens
  models: Record<string, ModelTally>
  tools: Record<string, ToolTally>
  agents: Record<string, number>
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  compacted: boolean
  ticket?: string
  version: string
}

// What the engine says when a main-thread turn completes, beside what the recording gathered.
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

const needsSplit = (body: QualityMeasurement['bodies'][number]): boolean => body.cc >= 6 && body.state !== 'legacy-unchanged'

export function qualityForTurn(measurement: QualityMeasurement | undefined, row: TurnRow): TurnQuality | undefined {
  if (measurement === undefined) return
  if (!(Date.parse(measurement.at) >= Date.parse(row.at) - row.durationMs)) return
  return {
    at: measurement.at,
    ccMax: Math.max(0, ...measurement.bodies.map(body => body.cc)),
    split: measurement.bodies.filter(needsSplit).length,
    unverified: measurement.unverified,
    tests: { status: measurement.tests.status, stale: measurement.tests.stale },
  }
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const tokensOf = (usage: ModelUsage | null | undefined): Tokens =>
  usage
    ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
    : NO_TOKENS

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const freshRecording = (costUsd = 0): Recording => ({
  name: '',
  costUsd,
  subagentUsage: NO_TOKENS,
  models: {},
  tools: {},
  agents: {},
  compacted: false,
})

// The next turn starts its tallies over; the name, ticket and cost baseline carry on.
export const nextRecording = (recording: Recording, costUsd: number): Recording => ({
  ...freshRecording(costUsd),
  name: recording.name,
  ...(recording.ticket === undefined ? {} : { ticket: recording.ticket }),
})

export function addStep(recording: Recording, step: { model: string; latencyMs: number; usage: Tokens }): Recording {
  const before = recording.models[step.model] ?? { ...NO_TOKENS, requests: 0, latencyMs: 0 }
  const after = { ...addTokens(before, step.usage), requests: before.requests + 1, latencyMs: before.latencyMs + step.latencyMs }
  return { ...recording, models: { ...recording.models, [step.model]: after } }
}

export function addToolCall(recording: Recording, call: { tool: string; ms: number; isError: boolean; isDenied: boolean }): Recording {
  const before = recording.tools[call.tool] ?? { calls: 0, errors: 0, denies: 0, ms: 0 }
  const after = {
    calls: before.calls + 1,
    errors: before.errors + Number(call.isError),
    denies: before.denies + Number(call.isDenied),
    ms: before.ms + call.ms,
  }
  return { ...recording, tools: { ...recording.tools, [call.tool]: after } }
}

export const addAgent = (recording: Recording, type: string): Recording => ({
  ...recording,
  agents: { ...recording.agents, [type]: (recording.agents[type] ?? 0) + 1 },
})

export const addSubagentUsage = (recording: Recording, usage: Tokens): Recording => ({
  ...recording,
  subagentUsage: addTokens(recording.subagentUsage, usage),
})

const toMicroDollars = (usd: number) => Math.round(usd * 1e6) / 1e6

export function foldTurn(recording: Recording, end: TurnEnd): TurnRow {
  const { cost, context, rateLimits } = end.sessionUsage
  const costUsd = cost?.usd ?? recording.costUsd
  // A cost below the baseline means the engine started its ledger over.
  const turnCostUsd = costUsd >= recording.costUsd ? costUsd - recording.costUsd : costUsd
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
    costUsd,
    turnCostUsd: toMicroDollars(turnCostUsd),
    model: end.model,
    usage: addTokens(end.usage, recording.subagentUsage),
    models: recording.models,
    tools: recording.tools,
    agents: recording.agents,
    context: { tokens: context.tokens, window: context.window, percent: context.percent },
    rateLimits: rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
    compacted: recording.compacted,
    ticket: recording.ticket,
    version: end.version,
  }
}

// A `[sidequest-route ... ticket=SQ-n ...]` marker anywhere wins over an SQ-n in the first line.
export function ticketRef(text: string): string | undefined {
  const routed = /ticket=(SQ-\d+)/.exec(text)
  if (routed) return routed[1]
  return /\bSQ-\d+\b/.exec(text.split('\n')[0] ?? '')?.[0]
}

export const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, 60)

// The first prompt names the task; any prompt may name the ticket it works.
export function notePrompt(recording: Recording, text: string): Recording {
  const ticket = ticketRef(text)
  return { ...recording, name: recording.name || firstLine(text), ...(ticket ? { ticket } : {}) }
}

// FNV-1a over the whole path: two projects named `app` in different folders get different ledgers.
// The module has no node:crypto, and six hex digits are plenty for one machine's projects.
const pathHash = (path: string): string => {
  let hash = 0x811c9dc5
  for (const char of path.replace(/\\/g, '/').toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

export const projectSlug = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const basename = (trimmed.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]/g, '_')
  return `${basename}-${pathHash(trimmed)}`
}

export const appendLine = (existing: string, row: TurnRow): string =>
  `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${JSON.stringify(row)}\n`

// Rows of one ledger at or after `since`; a line that does not parse (a write cut short) is skipped.
export function rowsSince(text: string, since: number): TurnRow[] {
  const rows: TurnRow[] = []
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (row !== undefined && Date.parse(row.at) >= since) rows.push(row)
  }
  return rows
}

const isTurnRow = (value: unknown): value is TurnRow =>
  typeof value === 'object' && value !== null && 'at' in value && typeof value.at === 'string'

function parseRow(line: string): TurnRow | undefined {
  try {
    const row: unknown = JSON.parse(line)
    return isTurnRow(row) ? row : undefined
  } catch {
    return undefined
  }
}
