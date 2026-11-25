import type { LiveAgent, LiveAgents, PermissionWaits, SidequestRun } from '../../types'
import { shortModelName } from '../routing'

// The fields of the host's agent list this plugin reads.
export type ListedAgent = { id: string; description: string; status: string }

export type RunningAgentRow = { agentId: string; what: string; ticket?: string; model: string; canBeViewed: boolean }

export const agentRunningOn = (rows: readonly RunningAgentRow[], ticketId: string): string | undefined => rows.find(row => row.ticket === ticketId)?.agentId

export type BoardActivity = {
  agents: LiveAgents
  runs: Record<string, SidequestRun>
  doingTickets: readonly string[]
  returnedTickets: readonly string[]
  // The tickets the pane lists under Being checked, so the band counts the same ones.
  beingCheckedTickets?: readonly string[]
  waits: PermissionWaits
  // How long the longest-waiting question has waited, in milliseconds, when the band was drawn.
  oldestWaitingMs?: number
  // The pieces of work whose questions wait on the person, by the name the person knows each by.
  piecesWaitingOnYou?: readonly string[]
}

type Runs = Record<string, SidequestRun>

const STILL_GOING = ['pending', 'running', 'waiting']

export const withTicketRef = (description: string, ticket: string | undefined): string =>
  ticket === undefined || description.includes(ticket) ? description : `${ticket} ${description}`

const trackedRow = (agentId: string, agent: LiveAgent, listed: readonly ListedAgent[], runs: Runs): RunningAgentRow => {
  const listedAgent = listed.find(one => one.id === agentId)
  const run = runs[agentId]

  return {
    agentId,
    what: listedAgent?.description ?? agent.description,
    ...(run?.ticket === undefined ? {} : { ticket: run.ticket }),
    model: shortModelName(agent.model),
    canBeViewed: listedAgent !== undefined,
  }
}

// The host lists loops it started without a spawn this plugin saw (a forked skill), so their model is unknown here.
const unseenRows = (listed: readonly ListedAgent[], agents: LiveAgents): RunningAgentRow[] =>
  listed
    .filter(one => STILL_GOING.includes(one.status) && !(one.id in agents))
    .map(one => ({ agentId: one.id, what: one.description, model: '', canBeViewed: true }))

export const runningAgentRows = (listed: readonly ListedAgent[], agents: LiveAgents, runs: Runs): RunningAgentRow[] => [
  ...Object.entries(agents).map(([agentId, agent]) => trackedRow(agentId, agent, listed, runs)),
  ...unseenRows(listed, agents),
]

export const runningTicketCount = (activity: BoardActivity): number => {
  const ticketsWithAgent = Object.keys(activity.agents).map(agentId => activity.runs[agentId]?.ticket)

  return activity.doingTickets.filter(id => ticketsWithAgent.includes(id)).length
}

const waitingName = (agentId: string, runs: Runs): string => runs[agentId]?.ticket ?? 'a background agent'

// An MCP tool's full name repeats its server's plumbing; the last part is the tool a person would recognise.
export const toolShortName = (tool: string): string => tool.split('__').at(-1) ?? tool

export const permissionWaitText = (waits: PermissionWaits, runs: Runs): string =>
  Object.entries(waits)
    .map(([agentId, tool]) => `${waitingName(agentId, runs)} waits on a permission for ${toolShortName(tool)}`)
    .join(', ')

const PERSON_IS_NEVER_ASKED = ['auto', 'dontAsk', 'bypassPermissions']

// In these modes an ask goes to a classifier or is settled without anyone, so nothing waits on the human.
export const asksAPerson = (permissionMode: string | undefined): boolean =>
  permissionMode === undefined || !PERSON_IS_NEVER_ASKED.includes(permissionMode)
