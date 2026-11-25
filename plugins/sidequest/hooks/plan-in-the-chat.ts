import { SHOW_THE_WHOLE_TEXT, sayOnly } from './chat-ending'
import type { ChatEnding } from './chat-ending'
import { chatBlockOf, missingOtherCostsLine } from './decisions-for-you'
import type { Story, Ticket } from './tickets'

// What a story write tells the session to say in the chat: after its questions, the analysis and the decisions; after
// its playback, the proposed tickets. With the board placed the chat only points at the plan view.

export const LONGEST_SHORT_VERSION = 200

const wordCount = (text: string): number => text.split(/\s+/).filter(word => word !== '').length

export const longShortVersionNote = (story: Story): string[] => {
  const words = wordCount(story.inShort)

  return words > LONGEST_SHORT_VERSION
    ? [`The inShort of ${story.id} is ${words} words, past about ${LONGEST_SHORT_VERSION} (written anyway): keep it to what is asked, how it works today, what was found and the options, and leave the rest to analysis.`]
    : []
}

const missingShortVersionNote = (story: Story): string[] =>
  story.inShort.trim() === '' ? [`${story.id} has no inShort (written anyway): patch it with the short version, which the plan view leads with.`] : []

export const pointerLine = (count: number): string =>
  `The analysis and ${count} ${count === 1 ? 'decision' : 'decisions'} are on the board (/board opens it). Pick there and Send, or type yes to take the recommended ${count === 1 ? 'answer' : 'answers'}.`

const SAY_ONLY_THE_POINTER = `Above the line below write one sentence on what is asked and one on the way you recommend, and nothing else: no analysis, no options, no decisions. ${sayOnly('three lines at most')}`

const notesBefore = (story: Story): string => {
  const notes = [missingOtherCostsLine(story.questions), ...missingShortVersionNote(story)].filter(note => note !== '')

  return notes.map(note => `\n\n${note}`).join('')
}

const wholeTextFor = (story: Story): string => [story.inShort.trim(), chatBlockOf(story.questions)].filter(part => part !== '').join('\n\n')

export const chatAfterPlan = (story: Story): ChatEnding | undefined => {
  if (story.questions.length === 0) return undefined
  const notes = notesBefore(story)

  return {
    withBoardPlaced: `${notes}\n\n${SAY_ONLY_THE_POINTER}\n\n${pointerLine(story.questions.length)}`,
    withNoBoard: `${notes}\n\n${SHOW_THE_WHOLE_TEXT}\n\n${wholeTextFor(story)}`,
  }
}

const proposedWords = (count: number): string => (count === 1 ? 'its proposed ticket is' : `its ${count} proposed tickets are`)

export const playbackPointerLine = (count: number): string =>
  `The plan and ${proposedWords(count)} on the board (/board opens it). Press "Yes, build it" there, or type yes; a correction works the same in either place.`

const SAY_ONLY_THE_PLAYBACK_POINTER = `Above the line below write one sentence on where it ends (a branch, a pull request, or the delivery rule), and nothing else: no ticket blocks, no defaults. ${sayOnly('three lines at most')}`

const WRITE_THE_WHOLE_PLAYBACK = 'No board pane is placed, so write the playback in the chat as the plan page lays it out, with these ticket blocks as they are:'

const ticketBlock = (ticket: Ticket, index: number): string =>
  [`${index + 1}. ${ticket.title}`, ticket.what.trim(), ticket.doneWhen.trim() === '' ? '' : `Done when:\n${ticket.doneWhen.trim()}`].filter(part => part !== '').join('\n\n')

// Made from the tickets as filed, so what the playback shows is what reaches them.
export const chatAfterPlayback = (proposed: readonly Ticket[]): ChatEnding | undefined =>
  proposed.length === 0
    ? undefined
    : {
        withBoardPlaced: `\n\n${SAY_ONLY_THE_PLAYBACK_POINTER}\n\n${playbackPointerLine(proposed.length)}`,
        withNoBoard: `\n\n${WRITE_THE_WHOLE_PLAYBACK}\n\n${proposed.map(ticketBlock).join('\n\n')}`,
      }
