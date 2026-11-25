import type { HookFailure } from 'claude-code'

const MAX_CAUSE_CHARACTERS = 300

// A timeout carries no message, so the kind is what is left to say.
export const causeOf = (failure: HookFailure): string => (failure.message ?? failure.kind).slice(0, MAX_CAUSE_CHARACTERS)

export const ownToolRefusal = (text: string, cause?: string): string =>
  `quartermaster: ${text}${cause === undefined ? '' : ` (${cause})`}`

export const evidenceToolRefusal = (folder: string | undefined, cause: string): string =>
  ownToolRefusal(`the evidence tool failed; read the event files directly in ${folder ?? 'the events folder'}`, cause)
