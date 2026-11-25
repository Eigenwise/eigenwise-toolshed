export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ModelTally = Tokens & { requests: number; latencyMs: number }

export type ToolTally = { calls: number; errors: number; denies: number; ms: number }

export type SpawnStart = { agentId: string; agentType: string; resolvedModel: string }

// What Sidequest publishes per routed agent under `sidequest.runs`. Read only; the owner's contract is the authority.
export type RoutedRun = { ticket?: string; category: string; model: string; effort: string; requestedModel: string }

// A spawn as it lands in the ledger. Routing fields are present only for agents Sidequest routed.
export type SpawnRow = {
  agentId: string
  agentType: string
  resolvedModel: string
  ticket?: string
  category?: string
  model?: string
  requestedModel?: string
}

// The turn in flight, plus what carries over between turns of one session.
export type Recording = {
  name: string
  ticket?: string
  // The session cost when the previous main turn ended: the baseline for this turn's own cost.
  costUsd: number
  // Tokens of subagent turns that completed during this main turn.
  subagentUsage: Tokens
  models: Record<string, ModelTally>
  tools: Record<string, ToolTally>
  agents: Record<string, number>
  spawns: SpawnStart[]
  compacted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    observability: { turn: Recording }
    sidequest: { runs: Record<string, RoutedRun> }
  }
}
