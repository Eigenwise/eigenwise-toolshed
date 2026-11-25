// `needsYou` counts every needs-you ticket; `needsYouFromEarlierWork` is how many of those this session never touched
// and that sat a day or more. `plansWaiting` is how many plans have decisions, or a yes, that wait on the person.
export type SidequestSummary = { needsYou: number; ready: number; doing: number; review: number; needsYouFromEarlierWork?: number; plansWaiting?: number }

// `model` is what the agent actually runs on; `requestedModel` is what the route or the caller asked for.
export type SidequestRun = {
  ticket?: string
  category: string
  model: string
  effort: string
  requestedModel: string
  toolUseId?: string
}

// `asked` is the opening of its prompt, kept so a lookup that has no ticket can still say what it was asked.
export type LiveAgent = { model: string; description: string; permissionMode?: string; asked?: string }

// Every spawn still running, routed or not, by agent id.
export type LiveAgents = Record<string, LiveAgent>

// Agent id to the tool its last permission ask was about, until that agent's next model request.
export type PermissionWaits = Record<string, string>

export type BoardCard = {
  id: string
  title: string
  status: string
  category: string
  updated: string
  // A doing ticket whose agent returned and that nobody recorded with finish yet.
  isReturnedNotRecorded?: true
  // A waiting ticket whose answer the person sent from the board: it is with the session, and waits on them no more.
  answerIsWithSession?: true
  // A ticket the person works with themselves whose turn has come: it is no plan's proposal, and what it waits for is built.
  isTheirsToDoNow?: true
  // The question from the ticket's For you section, shown in place of the title while it needs the person.
  question?: string
  // The answer the For you section recommends, in its own words, shown beside the question.
  recommended?: string
  issue?: string
  branch?: string
  startedBy?: string
  pullRequest?: string
  // The minute stamp of the last start on the log, while the ticket is doing.
  startedAt?: string
  // A ready ticket whose shared thing another doing ticket holds, in words: "waits for the stack, SQ-3 has it".
  waitsFor?: string
  // A doing or review ticket nothing runs in this session: what was known of its last activity when the cards were
  // drawn, in words like "files changed 40s ago" or "no run in this session".
  interrupted?: string
  // The stamp of the last line on the ticket's log, else the day it was last written: how the pane tells old work.
  lastTouched?: string
  // Blockers of this ticket that were dropped, so it waits on them for good until someone patches blockedBy.
  droppedBlockers?: string[]
  // The piece of work the ticket belongs to: its heading, its tracker key, the branch all its tickets share, and its
  // place in the board's order of work.
  piece?: { handle: string; trackerKey?: string; sharedBranch?: string; order: number; storyId?: string }
}

// `activity` is what the session is doing in a person's words and `since` when that started, in milliseconds.
export type SessionWork = { isWorking: boolean; steps: number; activity?: string; since?: number }

// Every agent of this session that returned, kept for the session so its row can still be pressed. `report` is what it
// handed back, as it wrote it. `mainTurnsSince` counts the main turns started after it returned: it reads as just
// finished through the turn its return wakes, which the host starts at once for a background agent.
export type FinishedAgent = {
  agentId: string
  what: string
  ticket?: string
  asked: string
  model: string
  effort?: string
  durationMs: number
  report: string
  mainTurnsSince: number
}

// A finished lookup opened in the pane. `transcript` says whether View can still put it in the main view: `gone` once
// the host no longer lists the agent, `elsewhere` on a surface with no main view.
export type FinishedAgentDetail = {
  agentId: string
  title: string
  asked: string
  facts: string
  report: string
  transcript: 'viewable' | 'gone' | 'elsewhere'
}

// A press writes the label on the ticket and says it to the session, the same as typing it.
export type AnswerOption = { key: string; label: string }

// One part of what the person says yes to: prose drawn as markdown, the hunks as a diff, and the words that go out
// as they are written.
export type SayingYesToShown = { key: string; heading: string; text: string; drawnAs: 'markdown' | 'diff' | 'words' }

// A ticket filed at a plan's playback, shown as its own block in the plan view until the yes. `changed` marks one a
// correction rewrote since the plan view last opened on it.
export type ProposedTicket = { id: string; title: string; what: string; doneWhen: string; changed?: true }

export type TicketDetail = {
  id: string
  title: string
  status: string
  canBeApproved: boolean
  facts: string
  // Drawn first with the answer buttons right under it; `forYouLines` holds the rest of the section.
  question: string
  forYouLines: string[]
  // A fenced diff in the For you part, drawn as a diff; empty when there is none.
  diff: string
  // What the person says yes to before a commit, drawn above the question, in the order it was filled in; empty on a
  // ticket that asks for no such yes. `isStillReviewed` is true while the review has not come back.
  sayingYesTo: SayingYesToShown[]
  isStillReviewed: boolean
  // Two or three lines that lead the commit question once the review is back, the parts then following it.
  summary: string[]
  // What the session left for the person to choose beside the question, each as one line they can tick.
  alsoYours: string[]
  // What Drop does to this ticket's files, branch and worktree, said before the press.
  dropWords: string
  options: AnswerOption[]
  body: string
  takesAnswer: boolean
  // What the person sent from the board while the answer is with the session, drawn in place of the form; else empty.
  answerSent: string
  // The minute it was sent, as `2026-11-25T16:20Z`; empty when not known.
  answerSentAt: string
}

// One open question as the plan view draws it, in the words the chat shows: the numbered question, the recommended
// answer (one line, or a heading line and one line per part), and what the other answer costs, which may be empty.
export type DecisionForYou = { question: string; recommended: string[]; otherwise: string }

// `picked` is an answer's label, empty while none is; `ticked` holds indexes into the ticket's `alsoYours`.
// `remarkSent` is the dim line drawn under a say field after its Send, empty until then and again once they type.
export type TicketForm = { id: string; picked: string; ticked: number[]; showsWhole: boolean; typed: string; remarkSent: string }

export type PlanForm = { id: string; otherAnswers: number[]; typed: string; remarkSent: string }

// One stop on the path a change runs through. `note` may be empty; `changed` marks a stop the change touches.
export type PathStep = { what: string; file: string; line: number; note: string; changed?: true }

// Lines of one file as they read today, `firstLine` the number of the first of them.
export type Excerpt = { file: string; firstLine: number; lines: string }

// `analysis` is empty when the story has none, and the view says so. `inShort` is the short version, empty when none
// was written. `decided` is what was already decided, as markdown.
export type StoryDetail = {
  id: string
  title: string
  inShort: string
  destination: string
  analysis: string
  path: PathStep[]
  excerpts: Excerpt[]
  decisionsForYou: DecisionForYou[]
  decided: string
  // The playback's first screen: the destination's first paragraph, and the answer of each decision taken by default.
  // The rest of the destination and the decisions in full are drawn after the yes.
  destinationLead: string
  destinationRest: string
  takenByDefault: string[]
  proposedTickets: ProposedTicket[]
  // What the person sent from the board on the decisions (per decision `recommended` or `other`, and their words) and
  // on the playback, while it is with the session; else empty. The view then draws what was sent in place of the form.
  decisionPicksSent: string[]
  decisionWordsSent: string
  playbackAnswerSent: string
}

// A story with an analysis the pane offers to open, by a heading row, even before it has a ticket. `openQuestions`
// counts the decisions that wait on the person; `awaitsYes` is set while the plan and its tickets wait for their yes;
// `answersWithSession` while what the person sent from the board on either is with the session.
export type StoryToRead = { id: string; title: string; openQuestions: number; awaitsYes?: true; answersWithSession?: true }

declare module 'claude-code' {
  interface PluginState {
    sidequest: {
      summary: SidequestSummary
      runs: Record<string, SidequestRun>
      agents: Shaped<LiveAgents>
      permissionWaits: PermissionWaits
      cards: Shaped<BoardCard[] | null>
      openTicket: Shaped<TicketDetail | null>
      // What the person picked and typed in a waiting ticket's form, kept apart so a redraw of the ticket keeps it until the send.
      ticketForm: Shaped<TicketForm>
      // Which of a plan's decisions the person turned to the other answer; every other one takes the recommended.
      planForm: Shaped<PlanForm>
      openStory: Shaped<StoryDetail | null>
      storiesToRead: Shaped<StoryToRead[]>
      boardWasOpened: boolean
      // The main loop's turn in progress, if any, and how many model requests it made so far.
      sessionWork: SessionWork
      // Every agent that returned in this session, newest last.
      finishedAgents: Shaped<FinishedAgent[]>
      // The finished agent whose view is open in the pane.
      openFinishedAgent: string | null
      // The pane lists the finished agents older than the newest three in place of the board.
      showsMoreFinished: boolean
      // True for the session in which the person first opened the board pane.
      showsBoardIntro: boolean
      // The pane lists the parked and not yet ready tickets in place of the board.
      showsSetAside: boolean
      // The pane lists the open tickets nobody touched for a week in place of the board.
      showsOlderTickets: boolean
      firstPromptSession: string
      // What the person could do themselves while something runs, the same lines the board tool's now view gives.
      whatYouCouldDo: string[]
      // Linked worktrees of this repository, counted at session start from git's own folder.
      worktreeCount: number
      worktreeToastSession: string
    }
  }
}
