import type { EngineInterface } from 'claude-code'

export function guardFailure($: EngineInterface, guard: string, tool: string, policy: 'closed' | 'open', error: unknown): string | null {
  const reason = error instanceof Error ? error.message : String(error)
  const message = `${guard} failed for ${tool}: ${reason}`
  $.ui.log(message, { to: 'debug' })
  $.ui.toast(message)
  return policy === 'closed' ? `sidequest: ${message}; tool call refused` : null
}
