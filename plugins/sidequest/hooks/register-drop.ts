import type { EngineInterface } from 'claude-code'

import { boardLocation, publishSummary, queueBoardWrite } from './board-session'
import { leftoversWords } from './drop'
import type { RunLeftovers } from './drop'
import { sessionRunsOf } from './register-interrupted'
import { writeBoardDecision } from './store'
import { answerLeavingOut, applyTicketOperations, PRESS_ON_THE_BOARD } from './ticket-tool'
import { minuteStamp, withChangedTickets } from './tickets'
import type { Ticket } from './tickets'
import type { JsonRecord } from './tool-input'

// Removing a worktree with git can take a while on a large checkout.
const SCRIPT_TIMEOUT = 60_000

const agentStillRunsWords = (leftovers: RunLeftovers): string =>
  `${leftovers.ticketId}: its agent is still running, so its worktree and branch ${leftovers.branch} are kept.`

// The tidy skill's own script gives the verdict and removes only what it calls safe, so drop never judges by itself.
async function removeIfSafe($: EngineInterface, root: string, leftovers: RunLeftovers): Promise<string> {
  const script = `${$.plugin.root}/scripts/worktrees.mjs`
  const argv = ['node', script, '--json', '--remove-safe', `--branch=${leftovers.branch}`]
  const answer = await $.process.run(argv, { cwd: root, timeoutMs: SCRIPT_TIMEOUT }).catch(() => undefined)

  return leftoversWords(leftovers, answer?.exitCode === 0 ? answer.stdout : undefined)
}

// Runs only on a drop, after the board was written: one process per dropped ticket that had a run.
export async function removeSafeLeftovers($: EngineInterface, leftovers: readonly RunLeftovers[]): Promise<string[]> {
  if (leftovers.length === 0) return []
  const [location, runs] = await Promise.all([boardLocation($), sessionRunsOf($)])
  const words: string[] = []
  for (const each of leftovers) {
    words.push(runs.liveTickets.has(each.ticketId) ? agentStillRunsWords(each) : await removeIfSafe($, location.root, each))
  }

  return words
}

export type PressOutcome = { text: string; tickets: Ticket[] }

// A press on the pane goes through the same operation the ticket tool runs, logged as the person's press. It costs
// no model turn: what happened is said in a toast.
export function pressOnTheBoard($: EngineInterface, operation: JsonRecord): Promise<PressOutcome | undefined> {
  return queueBoardWrite(async () => {
    const stamp = minuteStamp(await $.clock.now())
    const written = await writeBoardDecision($, await boardLocation($), files => applyTicketOperations({ operations: [operation] }, files, stamp, PRESS_ON_THE_BOARD))
    const outcome = written.decision
    const answer = answerLeavingOut(outcome, written.saved.notWritten)
    if (outcome.change === undefined || !('text' in answer)) return undefined
    const tickets = withChangedTickets(written.files.tickets, written.saved.tickets)
    await publishSummary($, tickets)
    const removals = await removeSafeLeftovers($, outcome.leftovers ?? [])

    const pressed = outcome.forThePerson?.(new Set(written.saved.notWritten)) ?? answer.text

    return { text: [pressed, ...written.saved.notes, ...removals].join(' '), tickets }
  })
}
