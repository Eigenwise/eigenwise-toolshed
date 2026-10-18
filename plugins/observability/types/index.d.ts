export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ModelTally = Tokens & { requests: number; latencyMs: number }

export type ToolTally = { calls: number; errors: number; denies: number; ms: number }

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
  compacted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    observability: { turn: Recording }
  }
}
