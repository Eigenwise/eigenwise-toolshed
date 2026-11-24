import { commandPrefix, failureSignature } from './events'
import type { DenialEvent, SensedEvent } from './events'

export type ToolOutcome = { tool: string; command?: unknown; isError: boolean; errorText: string }

const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

const isShell = (tool: string): boolean => SHELL_TOOLS.includes(tool)

const shellPrefixOf = (command: unknown): string => (typeof command === 'string' ? commandPrefix(command) : '')

const failureSignatureOf = (outcome: ToolOutcome): string =>
  isShell(outcome.tool) ? shellPrefixOf(outcome.command) : failureSignature(outcome.errorText)

/**
 * The only way a command becomes evidence of what a person does by hand.
 * A shell call by the model or a subagent never reaches it.
 */
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/

const lastTextOf = (blocks: readonly { type: string; text?: unknown }[]): string | undefined => {
  const texts = blocks.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))

  return texts[texts.length - 1]
}

/**
 * The command in a row a person's bash-mode line leaves in the conversation:
 * the last text block starts with the bash-input tag. Slash commands, local
 * commands and the shell's output start with other tags and never match.
 */
export const typedBashCommand = (blocks: readonly { type: string; text?: unknown }[]): string | undefined =>
  BASH_INPUT.exec(lastTextOf(blocks) ?? '')?.[1]

export const typedShellEvents = (commandText: string, at: string): SensedEvent[] => {
  const prefix = shellPrefixOf(commandText)

  return prefix === '' ? [] : [{ kind: 'typed', at, prefix }]
}

const failureEventsOf = (outcome: ToolOutcome, at: string): SensedEvent[] =>
  outcome.isError ? [{ kind: 'failure', at, tool: outcome.tool, signature: failureSignatureOf(outcome) }] : []

/**
 * What the permission path said about a call. A denial, by a rule or the
 * classifier, is already a denial event; an ask nobody could answer is one only
 * if the call then came back as an error.
 */
export type PermissionVerdict = 'denied' | 'nobody-to-ask'

const commandOf = (input: unknown): unknown =>
  typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined

export const toolCallEvents = (outcome: ToolOutcome, at: string, verdict?: PermissionVerdict): SensedEvent[] => {
  if (verdict === 'denied') return []
  if (verdict === 'nobody-to-ask' && outcome.isError) return [denialEvent(outcome.tool, { command: outcome.command }, at)]

  return failureEventsOf(outcome, at)
}

/**
 * A denial names its tool and, for a shell, the command prefix, so four denials
 * of `git push` group together while the arguments stay out of the log.
 */
export const denialEvent = (tool: string, input: unknown, at: string): DenialEvent => ({
  kind: 'denial',
  at,
  tool,
  target: isShell(tool) ? shellPrefixOf(commandOf(input)) : tool,
})

export class TurnBuffer {
  private events: SensedEvent[] = []
  private toolCount = 0

  add(events: readonly SensedEvent[]): void {
    this.events.push(...events)
  }

  pending(): SensedEvent[] {
    return [...this.events]
  }

  countToolCall(): void {
    this.toolCount += 1
  }

  /** What is still waiting when the session ends, with no turn to close. */
  drain(): SensedEvent[] {
    const drained = this.events
    this.events = []

    return drained
  }

  closeTurn(durationMs: number, at: string): SensedEvent[] {
    const closed: SensedEvent[] = [...this.events, { kind: 'turn', at, durationMs, toolCount: this.toolCount }]
    this.events = []
    this.toolCount = 0

    return closed
  }
}
