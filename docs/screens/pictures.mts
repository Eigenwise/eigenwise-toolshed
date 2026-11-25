// Every picture the pipeline takes: its file, its words for the page, and what draws it. The numbered ones are the
// walk-through, in the order things happen: one made-up task from the first message to the pull request on the board,
// then Quartermaster after the run. Each has a line to go under it. What only the app can show is listed in
// SCREENSHOTS-NEEDED.md instead.
import type { PictureSize } from './browser.mts'
import * as madeUp from './made-up.mts'
import { olderToolshedNotice, quartermasterInbox, seedOlderProject, upgradeScan } from './quartermaster-screens.mts'
import type { InboxDrawings } from './quartermaster-screens.mts'
import { usagePage } from './usage-page.mts'
import { boardOnly, minutesLater, opened, sessionWithTheBoard, storyIdOf, ticketIdOf } from './sidequest-screens.mts'
import { playTheStory } from './sidequest-story.mts'
import type { BoardMoment, PlayedStory, StoryState } from './sidequest-story.mts'

export type Picture = {
  file: string
  alt: string
  // The line under the picture on the walk-through, or under it wherever a page borrows it.
  caption: string
  drawnBy: string
  html: string
  // A page the plugin writes whole is shot as it is, at a set window size; the rest are cut to their drawing.
  isWholePage?: boolean
  windowSize?: PictureSize
}

const DOCS_OWN = "The window and the pane's border are the docs' own, and a field is drawn as its label and its text: the app draws those its own way."

const PANE = `Rendered from Sidequest's own pane code, with made-up tickets. ${DOCS_OWN}`
const SESSION =
  "Rendered from Sidequest's own pane, band and tool-row code, with made-up tickets. The person's message line, the prompt box, the band's place above it and the pane beside the chat are the docs' own, as are the window and the pane's border; the app draws those its own way, with its own rows around the plugin's."
const QUARTERMASTER = `Rendered from Quartermaster's own pane code, with made-up proposals. ${DOCS_OWN}`

const momentAt = (story: PlayedStory, state: StoryState): BoardMoment => {
  const moment = story.moments.get(state)
  if (moment === undefined) throw new Error(`the story never reached ${state}`)
  return moment
}

const FIRST_TICKET = madeUp.PLAN_TICKETS[0]?.title ?? ''
const LAST_TICKET = madeUp.PLAN_TICKETS[2]?.title ?? ''
const RECOMMENDED_ANSWER = madeUp.PERSON_PICKS
const MINUTES_INTO_THE_BUILD = 5

const planOpened = (moment: BoardMoment, planForm = {}) => opened(moment, { story: storyIdOf(moment), planForm })

const ticketOpened = (moment: BoardMoment, title: string, ticketForm = {}) => opened(moment, { ticket: ticketIdOf(moment, title), ticketForm })

type Frame = Omit<Picture, 'file'> & { name: string }

const planningFrames = (story: PlayedStory): Frame[] => [
  {
    name: 'first-message',
    alt: "A terminal session. The person typed Let's do PAY-41; the chat shows the board filing the plan, the band above the prompt says one plan needs you, and the board pane beside it says three decisions on the plan wait on the person.",
    caption: 'You name the task. The session reads the code, files a plan on the board, and the board opens beside the chat.',
    drawnBy: SESSION,
    html: sessionWithTheBoard(momentAt(story, 'planned')),
  },
  {
    name: 'board-plan-waits',
    alt: 'The board pane: under Waits on you, three decisions on the plan; under The plan, PAY-41 Upload retry.',
    caption: 'The board leads with what waits on you: three decisions on the plan.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'planned')),
  },
  {
    name: 'plan-open-decisions',
    alt: 'The plan opened in the board pane: its short version, then three decisions, each with its recommended answer and a choice between it and the other answer.',
    caption: 'Open the plan: the short version first, then each decision with a recommended answer.',
    drawnBy: PANE,
    html: planOpened(momentAt(story, 'planned')),
  },
  {
    name: 'plan-decisions-filled-in',
    alt: "The same decisions filled in before Send: the first two on the recommended answer, the third on the other answer, and the person's own words in the field under them.",
    caption: 'Answer all three in one form. Here the third takes the other answer, with your own words beside it.',
    drawnBy: PANE,
    html: planOpened(momentAt(story, 'planned'), { otherAnswers: madeUp.OTHER_ANSWERS_PICKED, typed: madeUp.PERSONS_OWN_WORDS }),
  },
  {
    name: 'plan-decisions-answered',
    alt: "The plan after Send: each decision shows the answer picked, and the person's own words are kept under them.",
    caption: 'After Send, each pick and your words stay on the plan while the session takes them in.',
    drawnBy: PANE,
    html: planOpened(momentAt(story, 'decisions-answered')),
  },
  {
    name: 'chat-decisions-sent',
    alt: "A terminal session: the person's one message with the answers to the three decisions and their own words, the board docked beside it.",
    caption: 'Send put your picks and your words in the chat as your one message.',
    drawnBy: SESSION,
    html: sessionWithTheBoard(momentAt(story, 'decisions-answered')),
  },
  {
    name: 'board-waits-for-the-yes',
    alt: 'The board pane: under Waits on you, the yes on the proposed tickets.',
    caption: 'The session wrote the plan back with three proposed tickets. Nothing is built until you say yes.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'before-the-yes')),
  },
  {
    name: 'plan-before-the-yes',
    alt: 'The plan before the yes: where it ends, what was taken by default, the Yes, build it button, then each proposed ticket in full.',
    caption: 'The plan before the yes: what was taken by default, the yes, then each proposed ticket in full.',
    drawnBy: PANE,
    html: planOpened(momentAt(story, 'before-the-yes')),
  },
]

const buildFrames = (story: PlayedStory): Frame[] => [
  {
    name: 'build-started',
    alt: "A terminal session: the person's yes, then the board's rows starting two tickets and the session handing each to a worker agent; the band above the prompt and the board docked beside it with both running.",
    caption: 'Your yes starts the build: the board starts each ticket and the session hands it to an agent.',
    drawnBy: SESSION,
    html: sessionWithTheBoard(momentAt(story, 'building')),
  },
  {
    name: 'plan-who-decided-what',
    alt: 'The plan after the yes: its short version, the code path, the analysis, and Already decided, with each decision marked as decided by the person or taken by default.',
    caption: 'Who decided what stays on the plan: your answers marked as yours, the rest as taken by default.',
    drawnBy: PANE,
    html: planOpened(momentAt(story, 'building')),
  },
  {
    name: 'ticket-opened',
    alt: "The first ticket opened while it is built: its title and facts, a field to say something about it, Set aside, Drop and Back, then What, Done when and Already decided.",
    caption: 'Any ticket opens in full: what to build, when it is done, and what it carries from the plan.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'building'), FIRST_TICKET),
  },
  {
    name: 'board-agents-running',
    alt: 'The board pane five minutes in: under Now, two tickets with the model each runs on and how long it has run; the third ticket waits under Next.',
    caption: 'Two agents run side by side, each on its own ticket.',
    drawnBy: PANE,
    html: boardOnly(minutesLater(momentAt(story, 'building'), MINUTES_INTO_THE_BUILD)),
  },
  {
    name: 'board-agents-finished',
    alt: 'The board pane after both agents came back: under Now, the one that just finished; both tickets under Being checked; the third under Next; the first agent under Finished agents.',
    caption: 'Both came back. Their tickets are being checked, and the third can start.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'agents-finished')),
  },
  {
    name: 'finished-agent-opened',
    alt: "The first ticket opened from its finished agent's row: its facts say built and being checked, then a field to say something about it, Set aside, Drop and Back, then What, Done when and Already decided.",
    caption: "A finished agent's row opens its ticket: built, and now being checked.",
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'agents-finished'), FIRST_TICKET),
  },
  {
    name: 'board-being-checked',
    alt: 'The board pane with all three tickets under Being checked.',
    caption: 'All three are built and being checked.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'being-checked')),
  },
  {
    name: 'ticket-being-checked',
    alt: 'The last ticket opened while the review runs: what changed, how it was checked, and the diff.',
    caption: 'What changed and how it was checked, readable while the review still runs.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'being-checked'), LAST_TICKET),
  },
]

const finishFrames = (story: PlayedStory): Frame[] => [
  {
    name: 'board-waits-on-you',
    alt: 'The board pane: under Waits on you, the last ticket with its question.',
    caption: 'The review passed. One question waits on you before anything leaves your machine.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'commit-question')),
  },
  {
    name: 'ticket-waits-on-you',
    alt: 'The ticket that waits on the person: a short summary, the question, why now, the answer buttons with the recommended one named, what else is theirs to tick, Send, and below it what they are saying yes to.',
    caption: 'The question with its answers, the recommended one named, and what you are saying yes to.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'commit-question'), LAST_TICKET),
  },
  {
    name: 'ticket-answer-picked',
    alt: 'The same ticket with the first answer picked, before Send.',
    caption: 'Pick an answer. Nothing goes out until you press Send.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'commit-question'), LAST_TICKET, { picked: RECOMMENDED_ANSWER }),
  },
  {
    name: 'ticket-answer-sent',
    alt: 'The ticket after Send: the answer sent, kept on the ticket, with the session now.',
    caption: 'Sent: your answer is kept on the ticket and goes to the session as your message.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'answered'), LAST_TICKET),
  },
  {
    name: 'pull-request-recorded',
    alt: "A terminal session: the person's answer as their message, then the board's row recording the pull request on the three tickets and moving them to done; the band above the prompt and the board docked beside it.",
    caption: 'The session commits, pushes and opens the pull request, then records it on the board.',
    drawnBy: `${SESSION} The commit, the push and the pull request are the host's own rows between the two, and are not drawn here.`,
    html: sessionWithTheBoard(momentAt(story, 'done')),
  },
  {
    name: 'board-done',
    alt: 'The board pane after the run: the three tickets under Done, and the agents that built them under Finished agents.',
    caption: 'The run is done: all three tickets carry the pull request.',
    drawnBy: PANE,
    html: boardOnly(momentAt(story, 'done')),
  },
  {
    name: 'ticket-pull-request',
    alt: 'The first ticket opened after the run: under its title, facts naming the branch, pull request #1 and done; Back; then What, Done when and Already decided.',
    caption: 'Where the work ended: the pull request, on the ticket. The merge itself happens on your code host.',
    drawnBy: PANE,
    html: ticketOpened(momentAt(story, 'done'), FIRST_TICKET),
  },
]

const quartermasterFrames = (inbox: InboxDrawings): Frame[] => [
  {
    name: 'quartermaster-inbox',
    alt: 'The Quartermaster pane: one proposal waiting, to add a script for the thumbnail build, and one thing noticed, the import proof blocked four times.',
    caption: '/quartermaster lists what waits: a proposal from before the run, and something it noticed during it.',
    drawnBy: QUARTERMASTER,
    html: inbox.waiting,
  },
  {
    name: 'quartermaster-proposal',
    alt: 'The script proposal opened: what it changes, how to undo it, why it was proposed, what Quartermaster checks later, a field for a reason, and Approve, Reject, Already handled, Later and Back.',
    caption: 'Open the proposal: what it changes, how to undo it and why it came up.',
    drawnBy: QUARTERMASTER,
    html: inbox.proposal,
  },
  {
    name: 'quartermaster-applied',
    alt: 'The Quartermaster pane after the proposal was applied: only the noticed line is left.',
    caption: 'After Approve the session makes the change, and the proposal leaves the list.',
    drawnBy: QUARTERMASTER,
    html: inbox.applied,
  },
  {
    name: 'standing-yes-noticed',
    alt: 'The noticed line opened: Claude tried npm run test:import four times and was blocked each time, when it was seen, and Draft a fix, Later, Ignore in this project and Back.',
    caption: 'The agents were blocked on the import proof. Draft a fix turns that into a proposal.',
    drawnBy: QUARTERMASTER,
    html: inbox.noticed,
  },
  {
    name: 'standing-yes-asked',
    alt: 'The permission proposal opened: Let Claude run npm run test:import without asking, the allow rule it adds and how to remove it, why, and Approve, Reject, Already handled, Later and Back.',
    caption: 'The standing yes, asked: let Claude run the import proof without asking.',
    drawnBy: QUARTERMASTER,
    html: inbox.standingYes,
  },
  {
    name: 'standing-yes-saved',
    alt: 'The Quartermaster pane after the standing yes was applied: nothing waits.',
    caption: 'Approved and saved in .claude/settings.local.json. Nothing waits in the inbox now.',
    drawnBy: QUARTERMASTER,
    html: inbox.standingYesSaved,
  },
]

const numbered = (frames: readonly Frame[]): Picture[] =>
  frames.map(({ name, ...frame }, index) => ({ ...frame, file: `${String(index + 1).padStart(2, '0')}-${name}.png` }))

const UPGRADE_FOLDERS = { home: 'upgrade/home', project: `upgrade/${madeUp.UPGRADE_PROJECT}` }

function upgradePictures(scratchFolder: string): Picture[] {
  const home = `${scratchFolder}/${UPGRADE_FOLDERS.home}`
  const olderProject = `${scratchFolder}/${UPGRADE_FOLDERS.project}`
  seedOlderProject(olderProject)

  return [
    {
      file: 'older-toolshed-notice.png',
      alt: 'The one notice a project gets when the older Toolshed left things in it, naming them and the command that moves them.',
      caption: 'Said once, at the first session in a project the older Toolshed left things in.',
      drawnBy:
        "The words come from Quartermaster's own notice lines, for a made-up project. Which of the older version's two folders the project holds is found by the pipeline, since the plugin's own session-start look needs the whole host engine. How the app shows a notice is its own; here it is a plain line.",
      html: olderToolshedNotice(olderProject),
    },
    {
      file: 'upgrade-scan.png',
      alt: "The upgrade's scan of a made-up project the older version left rules, a map and a plugin in: each leftover with its verdict, the deletion list and the questions.",
      caption: 'The scan the upgrade starts from: what the older version left, and what happens to each.',
      drawnBy: "Printed by Quartermaster's own scan script against a made-up project, with the scratch folders shown as ~/projects/trip-notes and ~. The window around it is drawn by the docs.",
      html: upgradeScan(olderProject, home),
    },
  ]
}

const USAGE_WINDOW = { width: 1440, height: 1900 }

const usagePicture = (scratchFolder: string, story: PlayedStory): Picture => ({
  file: 'usage-page.png',
  alt: "Observability's usage page for the made-up photo-library project: three days of thumbnail work, then the session named after Let's do PAY-41, with totals, cost per day, the models the sessions and their agents ran on, tools with the four blocked import runs counted as Bash errors, sessions and activity.",
  caption: 'Every turn of every session, totalled per day, model, tool and session.',
  drawnBy:
    "Observability's own page, written from ledger rows the plugin's own recording code made from the same made-up session, carried from turn to turn as its hook carries them, and opened in a browser with its clock set to UTC. A blocked command counts as an error there: the plugin counts a denial only when a plugin refused the call. The token counts and costs are made up.",
  html: usagePage(`${scratchFolder}/usage/home/.claude`, story),
  isWholePage: true,
  windowSize: USAGE_WINDOW,
})

// The inbox is opened an hour after the last step of the run.
const AFTER_THE_RUN = 60 * 60_000

export async function picturesOf(scratchFolder: string): Promise<Picture[]> {
  const story = await playTheStory(`${scratchFolder}/sidequest`)
  const inbox = await quartermasterInbox(`${scratchFolder}/quartermaster/${madeUp.SIDEQUEST_PROJECT}`, momentAt(story, 'done').now + AFTER_THE_RUN)
  const walkThrough = numbered([...planningFrames(story), ...buildFrames(story), ...finishFrames(story), ...quartermasterFrames(inbox)])

  return [...walkThrough, ...upgradePictures(scratchFolder), usagePicture(scratchFolder, story)]
}
