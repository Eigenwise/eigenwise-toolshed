export type RepeatedCommand = { command: string; count: number; lastWarning: number }
export type InlineWork = { boardInteraction?: boolean; substantiveActions?: number; advisorySurfaced?: boolean }
export type RepoFacts = { root: string; commonDir: string }

declare module 'claude-code' {
  interface PluginState {
    sidequest: {
      repeatedCommands: Record<string, RepeatedCommand>
      inlineWork: InlineWork
      repoRoot: Record<string, RepoFacts>
    }
  }
}
