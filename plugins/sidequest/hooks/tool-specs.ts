import type { ToolSpec } from 'claude-code'

import { isRecord } from './board-config'
import type { BoardIds } from './board-ids'
import { BOARD_VIEWS } from './board-tool'
import { FINISH_OUTCOMES } from './run-outcome'
import { OPERATION_NAMES } from './ticket-tool'
import { TICKET_KINDS, TICKET_MODES, TICKET_STATUSES } from './tickets'

const STATUS_WORDS = TICKET_STATUSES.join(', ')

export const BOARD_TOOL: ToolSpec = {
  name: 'board',
  description:
    'Read the Sidequest board in this project (.sidequest/). Pick a view: summary gives counts per status, the ids ready to start (ten named, rest counted), which ready ticket waits on which blocker (when nothing can start or a blocker is parked, dropped or missing), inbox titles (when nothing can start or a week old), how many are done earlier or parked, waiting gives everything that waits on the person (needs-you, or hitl and not done or parked), most blocking first, as blocks with lettered options, each with how long it has waited once that is a day (an older one this session did not touch goes last, as one line), then waiting tickets with no For you section yet, now says what else can move while something runs (what runs and for how long, what waits for a shared thing and behind which ticket, what could start, and what the person could do, with how long a question waited once that is a week), closing is the end report: one line per ticket this session created, started, finished or moved, and one count line for the rest, with no old titles, frontier lists every ready afk ticket whose blockers are all done (or in review with a passed or skipped review, if worktrees is false) and marks one that waits for a shared thing another ticket holds, then which ready ticket waits for which blocker, as the summary does, list gives one line per ticket (optionally one status; past 50 tickets a list with no status leaves done, parked and dropped out and ends with a line counting them), or one line per story with its ticket count when of is stories, ticket gives one ticket or story file in full, planning gives routing, the stories and open tickets, routing gives each category with its role, tier, model and effort plus the board settings (verify, planReviewPasses, worktrees, unrouted, checks, beforeBuilding) and each shared thing, defaults applied. A doing or review ticket that nothing runs in this session reads interrupted in the summary and the list, and stopped in now, beside its last known activity (files changed 40s ago, or no run in this session): earlier work, not a request; whether to resume, set aside or drop it is for the person to say. An agent back unrecorded gets a call-finish-now line (first in summary, last in now, not to paste). The summary also names any ready, doing, review or waiting ticket whose branch is not the one checked out (one line each, or one for all past three). A named ticket leads with its tracker key; its branch, pull request and "started by the session" follow the id, like PAY-41 SQ-12 (branch fix/pay-41, pull request #130). Waiting, now and closing group by piece of work (a story, or tickets with one tracker key) when there are several, this session\'s work first. In a repository with a remote, for tickets with a tracker key or a pull request: waiting asks the tracker where each pull request stands (changes requested, failing checks, a conflict with its base, approved), and a ticket whose pull request came back with changes requested or failing checks is listed as waiting on the person even when done; summary and now leave out of the interrupted work they offer to resume a ticket whose branch someone else committed to last, and say whose it is. An empty board names the folder it read. A missing or unknown view answers the summary, an unknown status or of lists every ticket, a ticket view with no id lists the tickets, and an unknown field is ignored; the answer names what it left out. Only the file named after its own id is a ticket: the summary and the list name any other file (a stray copy, one that cannot be read, a damaged one) and never list it as one; a ticket view of such an id says why. The first read of a session also says when board.json does not parse (defaults apply until it is fixed) and when the board folder is gone while .git/info/exclude still lists it. Only an unknown id is refused.',
  inputSchema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: [...BOARD_VIEWS],
        description:
          'Which view to return. summary: counts and what is ready. waiting: what waits on the person, written for them to answer cold; paste it to them in your closing report. now: what runs, what waits for a shared thing, what could start, and what the person could do meanwhile; paste it when they ask what they can do now, leaving out what follows "For the session, not to paste:" (call finish for an agent that is back; while one runs, end your turn, its return comes as a new one). closing: what this session changed and one count line for the rest; paste it as your closing report. frontier: tickets an agent can start now. list: one line per ticket as "id status category title", the tracker key before the id and branch and who started it after, when the ticket has them. ticket: the whole file of the ticket or story named by id. routing: categories, tiers and settings in force. planning: what the start of planning reads, in one call: the routing view, the stories and every ticket that is not done or dropped. Summary, now, frontier and planning leave out the proposed tickets of a plan (filed under a story whose awaitsYes is true, waiting for the person\'s yes) and name them apart; list marks them proposed. diagram: the path of the story named by id as a fenced Mermaid flowchart for a pull request description, changed stops marked; use it as it is, never type one.',
      },
      status: {
        type: 'string',
        enum: [...TICKET_STATUSES],
        description: `Only for view list: keep tickets with this status. Leave it out to list every ticket. One of ${STATUS_WORDS}.`,
      },
      of: {
        type: 'string',
        enum: ['tickets', 'stories'],
        description: 'Only for view list: tickets (the default) or stories, one line per story as "id title (n tickets)". Status does not apply to stories.',
      },
      id: {
        type: 'string',
        description: 'Only for view ticket: the ticket or story id to show in full, like SQ-12 or ST-3. For view diagram: the story.',
      },
    },
    additionalProperties: false,
  },
  isDeferred: true,
}

const DECISION_ITEM = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question that was settled, in one line.' },
    answer: { type: 'string', description: 'The answer that was chosen.' },
    decidedBy: {
      type: 'string',
      enum: ['human', 'default'],
      description: 'human when the person answered it, default when the recommended answer stood. Defaults to human.',
    },
  },
  required: ['question', 'answer'],
}

const QUESTION_ITEM = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'What the question is, in one line.' },
    recommended: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description: 'Your recommended answer, written the way the code will read, like retries: number. Several parts: a list of strings, one per line. Drawn as written, one part or several: a part that reads as code in backticks, prose plain.',
    },
    otherCosts: { type: 'string', description: 'What the other answer is and what it costs, in one line. The reply says when a question has none.' },
  },
  required: ['question', 'recommended'],
}

const PATH_STEP_ITEM = {
  type: 'object',
  properties: {
    what: { type: 'string', description: 'What happens at this stop, in a few words.' },
    file: { type: 'string', description: 'The file, relative to the project root.' },
    line: { type: 'integer', description: 'The line in that file.' },
    note: { type: 'string', description: 'Optional: what changes here, in a few words.' },
    changed: { type: 'boolean', description: 'Optional: true when the change touches this stop; the diagram marks it.' },
  },
  required: ['what', 'file', 'line'],
}

const EXCERPT_ITEM = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The file, relative to the project root.' },
    firstLine: { type: 'integer', description: 'The number of the first line given.' },
    lines: { type: 'string', description: 'The lines as they read today, joined with newlines.' },
  },
  required: ['file', 'firstLine', 'lines'],
}

const FOR_YOU_OPTION = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'The option in a few plain words.' },
    gets: { type: 'string', description: 'What the person gets if they pick it.' },
    costs: { type: 'string', description: 'What it costs them: money, time, something they lose.' },
  },
  required: ['label', 'gets', 'costs'],
}

const FOR_YOU_FIELD = {
  type: 'object',
  description:
    'For create and patch on a ticket that waits on the person: what they are asked (a change shown before a commit goes in a ```diff fence, drawn as a diff), written so someone who was not here can answer it from a phone. No ticket ids, internal names or words this project invented. Written as the For you section of the ticket; on patch only the parts given change. Park only what cannot be undone, spends money or reaches outside the project, or is taste or product direction only the person has. Any other choice with a recommended answer: take it and note what you chose and how to undo it.',
  properties: {
    question: {
      type: 'string',
      description: 'One short line that starts with the verb, like "Commit, push and open the pull request?". What it is about goes in the lines above it in the chat, and why in whyNow.',
    },
    whyNow: { type: 'string', description: 'Why it is asked now and what waits on it.' },
    options: {
      type: 'array',
      items: { anyOf: [FOR_YOU_OPTION, { type: 'string' }] },
      description: 'Each choice with what the person gets and what it costs them: an object, or a string "Label: what it gets Costs: what it costs".',
    },
    alsoYours: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              what: { type: 'string', description: 'What it is, in a line.' },
              doneByDefault: { type: 'string', description: 'What happens if they say nothing.' },
            },
            required: ['what'],
          },
          { type: 'string' },
        ],
      },
      description: 'Things you left for the person to choose beside the question, like a review note you did not act on or an offer. They tick the ones to do too; the waiting view numbers them, 1, 2 under a question that waits alone and 2.1, 2.2 under question 2 when several do.',
    },
    recommended: { type: 'string', description: 'The option you recommend, by its label, and why in a few words.' },
    ifUnanswered: { type: 'string', description: 'What happens if they never answer.' },
    steps: { type: 'string', description: 'For a task with no decision in it, in place of options: what to open and what to look for.' },
    sayingYesTo: {
      type: 'object',
      description:
        'Before a commit, a push or a pull request that waits on the person: what they say yes to, kept as written and drawn above the question in the ticket view. Fill it in two steps. Once the proof has run, while the review still runs: changed, checked and hunks. When the review is back: reviewFound and the words that go out, with the question. Each step\'s reply ends with what to say in the chat: one line when the board pane is placed, else the whole text. Send the stored words as they are: words changed after the yes are logged and named in the closing view.',
      properties: {
        changed: { type: 'string', description: 'What changed, a line per area, as markdown, and the one command that shows the whole diff.' },
        checked: { type: 'string', description: 'How it was checked so far: only what has finished, rewritten when it changes.' },
        hunks: { type: 'string', description: 'The hunks that carry the design, as a diff, fenced or bare.' },
        reviewFound: { type: 'string', description: 'What the review found; a fail says what changes in what they read.' },
        commitMessage: { type: 'string', description: 'The commit message as it goes out.' },
        pullRequestTitle: { type: 'string', description: 'The pull request title as it goes out.' },
        pullRequestDescription: { type: 'string', description: 'The pull request description as it goes out, as markdown.' },
      },
    },
  },
}

export const TICKET_TOOL: ToolSpec = {
  name: 'ticket',
  description:
    'Write to the Sidequest board: create tickets and stories, patch them, move a ticket to another status, add a note to its log, stop a plan, or drop a ticket. Send a list of operations; they run in order and the reply names every id touched. Ids carry this board\'s prefix: tickets like SQ-12, stories like ST-3. A new board takes its prefix from the folder name at its first ticket or story, never one a tracker key in the branch names uses, and keeps it as prefix in .sidequest/board.json; the reply says which. Three slips are read, not refused, and the reply says how: one operation sent at the top level with no operations list (id and status are a move, id and text or note are a note), a note whose words are in a field called note, and op status with a status (a move). An op finish is left out and the reply names the finish tool, which records a run result; the rest of the batch is written. If any operation is wrong (an unknown field, a wrong type, an unknown op or id) nothing is written and the reply lists each problem with the accepted field names, so send the whole list again. A value a field cannot take (a status, kind, mode, story, startedBy or blockedBy) does not stop the batch: it is read where the meaning is plain (another letter case, spaces, a startedBy that begins with session), else the field keeps what it had, and the reply names each one with what the field takes. A blockedBy id that is not on the board, and a category with no route, are written anyway and named in the reply: start runs such a ticket on the build category. A created ticket gets branch (the branch checked out now) and issue (a tracker key like PAY-41 at the start of the title or in the branch name) unless you give them. Whenever a write makes a ticket wait on the person, the reply carries the rule for what is worth their time, names any For you parts still missing (it is written anyway), and, once there is a question, prints that ticket\'s waiting block, short for the chat: show it to the person as it is. Parked means not without the word of the person: whenever a write takes a ticket out of parked, the board logs the words of the turn it happened in. When the person says stop, not now, or to do something else instead, call stop once: it parks the tickets of that plan that have not started, with their words, and leaves running ones to finish and report. A session that remembers creating no ticket (lost on resume or reload) parks nothing on a stop with no story: the reply says so and names the ready and inbox tickets created in the last day, to move to parked or stop by their story. When a created ticket carries the tracker key of another open ticket outside its story, the reply adds one line naming that ticket, once per older ticket however many new ones share its key, and once per pair in this session. It is a fact, not a question: carry on unless they really conflict. When the person says to drop a ticket, call drop: it becomes dropped (never offered, not counted, and a ticket it blocks stays blocked), the board logs their words, and its worktree and branch are removed only where the worktree check calls them safe; the reply names what was removed and what was kept. A move brings it back. Setting a doing or review ticket aside is a move to parked; its branch and worktree are kept. A new ticket whose id another session filed at the same moment gets the next free id, and the reply says so: use that id. A ticket that changed on disk during the call is redone once on the new text; if it changed again, nothing is written to it and the reply says so. A create made outside the project of the board says which board the ticket went to. A write that names a file that cannot be read or is damaged is refused. A missing board.json is rewritten with the tickets\' prefix by the next write that gives out an id; one that does not parse is left as it is.',
  inputSchema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        minItems: 1,
        description:
          'The operations to apply, in order. A later operation can name an id an earlier one in this call created: ids are given out in the order the creates run, each one past the highest on the board, like SQ-12 then SQ-13, and ST-3 then ST-4.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: [...OPERATION_NAMES],
              description:
                'What this operation does. create: a new ticket (needs title). story: a new story (needs title). patch: change fields of the ticket or story named by id; a patch that changes a status or title on a ticket logs the old and the new value. move: set the status of the ticket named by id and log the move; any status is allowed from any status, and a status the board does not know leaves the ticket where it is. note: append text to the log of the ticket named by id. stop: the person stopped or called off the plan (stop, not now, do this instead); with story, park the ready and inbox tickets of that story and clear its awaitsYes, without it the ones this session created, each logged with the words the person typed; running tickets are left to finish and the reply names them. drop: the person dropped the ticket named by id; it is set to dropped with their words, and its worktree and branch are removed only when safe. A move to dropped does the same.',
            },
            id: {
              type: 'string',
              description: 'For patch, move, note and drop: the ticket (SQ-12) or, for patch only, the story (ST-3) to change.',
            },
            title: { type: 'string', description: 'For create, story and patch: a short name for the work, in the user\'s words.' },
            what: {
              type: 'string',
              description: 'For create and patch on a ticket: the behaviour this ticket makes work, from the user\'s side, as markdown. No file paths, except on a research ticket, which also says where to work and with what: a scratch folder, an interpreter, what it must not touch.',
            },
            doneWhen: {
              type: 'string',
              description: 'For create and patch on a ticket: markdown checklist of checks that fail today and pass when the ticket is done, each one a person can judge, like "- [ ] a failed upload is retried twice, then reported". A check the person worded is written exactly as they said it, the line starting "In the person\'s words:".',
            },
            status: {
              type: 'string',
              enum: [...TICKET_STATUSES],
              description: `For move (required), create and patch: the ticket status. One of ${STATUS_WORDS}. create defaults to ready.`,
            },
            kind: {
              type: 'string',
              enum: [...TICKET_KINDS],
              description: 'For create and patch on a ticket: build (code changes, finishes into review), decision, research or review. Defaults to build.',
            },
            mode: {
              type: 'string',
              enum: [...TICKET_MODES],
              description: 'For create and patch on a ticket: afk when an agent can finish it alone, hitl when it needs the human and must never be dispatched. Defaults to afk.',
            },
            category: {
              type: 'string',
              description: 'For create and patch on a ticket: the category of work, which picks the model and effort. A name from board.json categories; the defaults are explore, research, quick, build, hard, debug, review and outside-code. Defaults to build.',
            },
            story: {
              type: 'string',
              description: 'For create and patch on a ticket: the story id this ticket belongs to, like ST-3. An empty string on patch removes it. For stop: the story whose plan the person stopped; leave it out to stop the tickets this session created, which a resumed or reloaded session no longer knows.',
            },
            branch: {
              type: 'string',
              description: 'For create and patch on a ticket: the git branch this work is on: create defaults to the branch checked out now, and finish replaces it with the named branch it was given when a local branch of that name exists. start never merges it; the name for a worker branch goes in the delivery of start. An empty string on patch removes it.',
            },
            issue: {
              type: 'string',
              description: 'For create and patch on a ticket: the key the person\'s tracker knows this work by, like PAY-41. create takes it from the start of the title or from the branch name when one is there. An empty string on patch removes it.',
            },
            pullRequest: {
              type: 'string',
              description: 'For create and patch on a ticket: the address of the pull request that carries this work, or its number like #130. Set it when you open one for the ticket\'s branch. An empty string on patch removes it.',
            },
            startedBy: {
              type: 'string',
              description: 'Leave this out in almost every case: a ticket the person asked you to file or to work on is theirs. Set it to session only when you open work that the person\'s latest message did not ask for, and say so to the person first. An empty string on patch removes it.',
            },
            blockedBy: {
              type: 'array',
              items: { type: 'string' },
              description: 'For create and patch on a ticket: ticket ids that must be done before this one can start. Replaces the whole list on patch.',
            },
            uses: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For create and patch on a ticket: names from settings.shared in .sidequest/board.json (a running stack, a database, a port) that this ticket holds for its whole run, so two tickets that use one take turns. Leave it out for work that only reads and edits. A name the board does not know is written and named in the reply. Replaces the whole list on patch; an empty list removes it. When the person says something shared is busy, create a hitl ticket in doing that uses it, and move it to done when they say it is free.',
            },
            decisions: {
              type: 'array',
              description:
                'On a ticket (create, patch): the story decision ids it rests on, like ["D-2"], replacing the list on patch. The brief carries those decisions and no others; a ticket that names none gets every decision of the story. On a story (story, or patch on a story): decisions to append, each { question, answer, decidedBy }, numbered D-1, D-2 and on.',
              items: { anyOf: [{ type: 'string' }, DECISION_ITEM] },
            },
            destination: {
              type: 'string',
              description: 'For story and patch on a story: where the work ends up, what is true for the user when the story is done.',
            },
            inShort: {
              type: 'string',
              description:
                'For story and patch on a story: the short version, written once, as markdown: what is asked, how it works today, what you found, then the options by letter, one line each, with the one you recommend. A finding that is itself one of the decisions is left out: the decision says it. About 200 words at most; the reply says when it is longer (written anyway). The plan view leads with it, and where no board pane is placed, the reply hands it to the chat.',
            },
            outOfScope: {
              type: 'string',
              description: 'For story and patch on a story: what this story will not do, as markdown.',
            },
            handOver: {
              type: 'string',
              description:
                'For story and patch on a story: what was agreed with the person, for a step before building to read from the story file, as markdown under these headings: Goal, Needs first, Risks, Slices, Open questions, Links.',
            },
            analysis: {
              type: 'string',
              description:
                'For story and patch on a story: the plan the person reads on the board, as markdown, in this order: what is asked, how it works today in words, what surprised you, then the options under a heading Options, lettered A, B, C (the same set inShort names; no option is numbered), each with where it lands. The open questions go in questions, the path through the code in path and the code in excerpts, never here and never drawn with typed characters. No tables: the pane is too narrow for one, so write rows as list lines (small, large: asked fast, served priority). Shown in the pane as the plan view.',
            },
            path: {
              type: 'array',
              items: PATH_STEP_ITEM,
              description:
                'For story and patch on a story: the path the change runs through, as data, a short list of stops in order. The board draws each as a box with an arrow to the next, and places it once in the transcript when a story first gets one. Never draw it yourself with typed characters. Replaces the list on patch; an empty list removes it.',
            },
            excerpts: {
              type: 'array',
              items: EXCERPT_ITEM,
              description:
                'For story and patch on a story: the code that matters, as it reads today, about a dozen lines each. The board draws it as code with line numbers. Replaces the list on patch; an empty list removes it.',
            },
            questions: {
              type: 'array',
              items: QUESTION_ITEM,
              description:
                'For story and patch on a story: the decisions that wait on the person, in the order to ask them. The board numbers them 1, 2, 3, draws each as three lines (the question, Recommended, Otherwise), writes them in the story under Decisions for you, shows them in the plan view, and ends the reply with what to say in the chat, in the shape it names: with the board pane placed, two sentences of yours above its pointer line; with no board, the short version and the block, as they are. Replaces the list on patch; an empty list removes it. When one is answered, append it to decisions and patch questions without it.',
            },
            awaitsYes: {
              type: 'boolean',
              description:
                "For story and patch on a story: true at the playback, in the call that files the plan's tickets under this story. Until the yes they are proposed: never started, counted or listed as open work, shown in the plan view as Proposed tickets with Yes, build it, and the reply ends with what to say in the chat (a pointer when the board pane is placed, else the ticket blocks for the whole playback). Patch the tickets for a correction. false on the person's yes, which makes them live; stop with the story parks them and clears it.",
            },
            forYou: FOR_YOU_FIELD,
            text: { type: 'string', description: 'For note: the line to append to the ticket log. One line.' },
          },
          required: ['op'],
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const START_TOOL: ToolSpec = {
  name: 'start',
  description:
    'Start a ticket: marks it doing, logs the start, and returns the exact Agent tool call to make next, with subagent_type (sidequest:worker, sidequest:scout or sidequest:outside-code-reviewer by category), model, effort, isolation, name and the full brief as prompt. Pass a rule you were handed on where commits go (no branch, no pull request; not the checkpoints question) as delivery: the brief carries it in a Delivery section and the start log line records it. Make that call as given. When the board\'s folder is not a git repository the call has no isolation, because the host cannot make a worktree there: the answer says so, and the brief tells the worker to make its own worktree in the repository the ticket names; a ticket whose text names no repository folder is said too, to add it before the call. Started on an interrupted ticket, the brief adds what changed since: the commits already on its branch, uncommitted files in its worktree, files it touched that changed on the base, a last commit by someone else, a remote that moved, and a branch already merged into the base. When the agent returns, the board logs what it returned on the ticket by itself; finish then adds what you checked and moves the ticket. Started on a ticket that is already doing (and is not an interrupted one being resumed), the answer begins by saying it was already started, when, and whether an agent of this session is on it right now or none is and another session\'s agent may be, which this session cannot know; the Agent call is still returned, so make it only when a second agent on that ticket is wanted, and the log marks the start as a repeat. When no agent was spawned from the earlier start (nothing on the log follows it), the answer says that start never became an agent and gives the brief again from the ticket as it is now, and the log gets no repeat line. A ticket with a blocker that is not done (one in review counts only when worktrees is false and its review passed or was skipped), and a done or dropped ticket, is started all the same, and the answer says so before the call. For a ticket in a story or with a blocker, a worker in a worktree is told to merge the branch checked out in the main checkout at start, never the branch field of the ticket; with no remote or no checked-out branch the brief has no such section. Every start keeps the brief in .sidequest/briefs/<id>.md, and for a build ticket the answer names that file: name it to the reviewer. On a board that runs agents in worktrees a start adds .claude/worktrees/ to .git/info/exclude unless that file or the root .gitignore lists it, and says so once. A hitl ticket is refused because it needs the human, and so is an id that is not on the board. A ticket whose story has awaitsYes true is refused: its plan still waits for the person\'s yes. A ticket that uses a shared thing another doing ticket holds is not started: the answer names the thing and the holder, and alongside: true starts it anyway with that on the log. When the started ticket uses a shared thing, the answer ends with what can go alongside it and what the person could do meanwhile: offer those to the person and start only what they pick. A category with no route runs on the build category, and the answer and the log say so. When another open ticket outside its story carries the same tracker key, the answer ends with one line naming it, once per pair in this session. It is a fact, not a question: carry on unless they really conflict. For a ticket with a tracker key in a repository with a remote, start looks once for an open pull request by someone else or a remote branch someone else committed to that carries the same key; when there is one, the answer ends with one line saying who and where, and the ticket is started all the same: pass that on to the person. An unknown field is ignored and named.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The ticket to start, like SQ-12. Pick one from the board tool\'s frontier view.' },
      delivery: { type: 'string', description: 'Optional. The delivery rule for this run in your own words: where its commits go, no branch, no pull request. The worker follows it over its own default. Leave it out when no rule was given.' },
      alongside: {
        type: 'boolean',
        description: 'Optional. true starts the ticket although a shared thing it uses is held by another doing ticket, and logs that it did. Only when the person said so, or the two runs cannot get in each other\'s way.',
      },
      forWave: {
        type: 'boolean',
        description: 'Optional. true when the ticket runs in a wave: the brief is kept in a file, and the answer prints no brief and no Agent call but the ticket\'s entry for the wave and the review route, each as a line of JSON to pass on as they are.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const FINISH_TOOL: ToolSpec = {
  name: 'finish',
  description:
    'Record what a routed agent returned for a ticket. Appends the result to the ticket log and moves the ticket: done goes to review for a build ticket and to done for any other kind, needs-you and failed go to needs-you, so a failed run waits for the human instead of starting again. Copy the fields from the agent\'s result as it reported them. A branch someone chose becomes the branch field of the ticket; a worktree-agent-* branch is temporary and leaves it. The board already logged what the agent returned when it ended, one block per agent run (a later stop of the same agent replaces an earlier one that held no result, and is ignored after a real result), and finish does not repeat a line that is already there. It takes what it is given: an unknown field is ignored and named, a missing or other outcome is read (review, reviewed or ready for review is done, a word starting with fail or error is failed, a word naming a need or a needs other than nothing is needs-you, else done) and the answer says which, and a missing result is logged as not recorded. With neither an outcome nor a result the run returned nothing: that is failed, and the ticket waits on the person. A ticket that reaches review or done with no checked, or a checked that says it was not checked, gets the log line nothing was checked, the answer says so, and the closing view marks it. When this is the first ticket on the board to reach review or done, is a build ticket and settings.verify is empty, the answer adds one line saying no verify command is set and that this ticket\'s check goes into settings.verify in .sidequest/board.json if it is the project\'s check. When a file the agent changed (its changedFiles, else its branch) was also changed on the unmerged branch of another open ticket, the answer ends with one line naming that ticket, the file and its branch, once per pair in this session; lockfiles and generated or ignored files do not count. It is a fact, not a question: carry on unless they really conflict. Only an id that is not on the board is refused.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The ticket the agent worked on, like SQ-12.' },
      outcome: {
        type: 'string',
        enum: [...FINISH_OUTCOMES],
        description: 'done when the agent reports the work finished, needs-you when it needs a decision only the human can take, failed when it could not do the work.',
      },
      result: { type: 'string', description: 'What is now true, in one or two sentences, from the agent\'s result.' },
      checked: {
        type: 'string',
        description: 'The exact command the agent ran to check its work and the exit code, or "not checked" and why.',
      },
      uncertain: { type: 'string', description: 'What the agent assumed, skipped or could not verify. Leave out when it reported nothing.' },
      needs: { type: 'string', description: 'The decision or action only the human can take, or "nothing".' },
      branch: { type: 'string', description: 'The branch holding the agent\'s commits, when it wrote code. A named branch replaces the branch field of the ticket only when it is one name and a local branch of that name exists; worktree-agent-* does not.' },
      commits: { type: 'integer', description: 'How many commits the agent made on that branch.' },
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'The paths the agent changed, as it listed them.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const SIDEQUEST_TOOLS: readonly ToolSpec[] = [BOARD_TOOL, TICKET_TOOL, START_TOOL, FINISH_TOOL]

// The specs are written with the ids of a board from before prefixes, and each session registers them with its own
// board's, so an example never shows the model letters this board does not use.
const describedOn = (text: string, ids: BoardIds): string =>
  text.replace(/\bSQ-(\d+)\b/g, `${ids.ticketPrefix}$1`).replace(/\bST-(\d+)\b/g, `${ids.storyPrefix}$1`)

const schemaValueOn = (value: unknown, ids: BoardIds): unknown => {
  if (typeof value === 'string') return describedOn(value, ids)
  if (Array.isArray(value)) return value.map(item => schemaValueOn(item, ids))

  return isRecord(value) ? schemaOn(value, ids) : value
}

const schemaOn = (schema: Record<string, unknown>, ids: BoardIds): Record<string, unknown> =>
  Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, schemaValueOn(value, ids)]))

const toolOnBoard = (tool: ToolSpec, ids: BoardIds): ToolSpec => ({
  ...tool,
  description: describedOn(tool.description, ids),
  ...(tool.inputSchema === undefined ? {} : { inputSchema: schemaOn(tool.inputSchema, ids) }),
})

export const sidequestToolsOn = (ids: BoardIds): ToolSpec[] => SIDEQUEST_TOOLS.map(tool => toolOnBoard(tool, ids))
