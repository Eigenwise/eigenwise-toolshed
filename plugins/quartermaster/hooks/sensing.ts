import { commandPrefix, failureSignature, isShellTool } from './events'
import type { DenialEvent, SensedEvent } from './events'
import { errorWordsOf, failedCommandName, wasCutShort, wasRejectedByPerson } from './shell-failure'

export type ToolOutcome = { tool: string; command?: unknown; isError: boolean; errorText: string }

const shellPrefixOf = (command: unknown): string => (typeof command === 'string' ? commandPrefix(command) : '')

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

const shellFailureEvents = (outcome: ToolOutcome, at: string): SensedEvent[] => {
  const command = typeof outcome.command === 'string' ? outcome.command : ''
  const signature = failedCommandName(command, outcome.errorText)

  return signature === undefined
    ? []
    : [{ kind: 'failure', at, tool: outcome.tool, signature, error: errorWordsOf(outcome.errorText) }]
}

const failureEventsOf = (outcome: ToolOutcome, at: string): SensedEvent[] => {
  if (!outcome.isError || wasRejectedByPerson(outcome.errorText) || wasCutShort(outcome.errorText)) return []
  if (isShellTool(outcome.tool)) return shellFailureEvents(outcome, at)

  return [{ kind: 'failure', at, tool: outcome.tool, signature: failureSignature(outcome.errorText) }]
}

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
  target: isShellTool(tool) ? shellPrefixOf(commandOf(input)) : tool,
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
