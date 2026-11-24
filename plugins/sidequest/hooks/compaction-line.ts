import { summarize } from './summary'
import type { Story, Ticket } from './tickets'

const LIVE_STATUSES = ['doing', 'review', 'needs-you', 'ready']

const RELOAD_THE_SKILL =
  "Load the sidequest:sidequest skill again before you go on with the person's request, its rules did not survive the compaction."

const storyInFlight = (tickets: readonly Ticket[], stories: readonly Story[]): string => {
  const storyId = LIVE_STATUSES.flatMap(status => tickets.filter(ticket => ticket.status === status)).find(ticket => ticket.story)?.story
  const story = stories.find(one => one.id === storyId)

  return story ? `story ${story.id} (${story.title}) is in flight, ` : ''
}

const counted = (count: number, words: string): string => (count > 0 ? `${count} ${words}` : '')

const liveCounts = (tickets: readonly Ticket[]): string[] => {
  const summary = summarize(tickets)

  return [
    counted(summary.doing, 'doing'),
    counted(summary.review, 'in review'),
    counted(summary.needsYou, 'waiting on the human'),
    counted(summary.ready, 'ready'),
  ].filter(part => part !== '')
}

const sessionWorkWords = (touched: readonly Ticket[], stories: readonly Story[]): string => {
  const counts = liveCounts(touched)

  return counts.length === 0 ? '' : ` The board work this conversation touched: ${storyInFlight(touched, stories)}${counts.join(', ')}.`
}

// Open tickets an earlier session left are not this conversation's work, and counting them read as an instruction to
// carry on with them, so only the tickets this session created, started or finished are counted.
export const afterCompactionLine = (
  tickets: readonly Ticket[],
  stories: readonly Story[],
  ticketsThisSessionTouched: ReadonlySet<string>,
): string | undefined => {
  if (liveCounts(tickets).length === 0) return undefined
  const touched = tickets.filter(ticket => ticketsThisSessionTouched.has(ticket.id))

  return `Sidequest: this conversation was just compacted.${sessionWorkWords(touched, stories)} ${RELOAD_THE_SKILL}`
}
