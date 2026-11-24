import { AUTHORITIES, PROPOSAL_KINDS, PROPOSAL_STATUSES } from './proposals'

export const EVIDENCE_TOOL = {
  name: 'evidence',
  description:
    'What Quartermaster has noticed in this project over the last 30 days: each candidate with its fingerprint, count and a plain sentence ("ran `npm run` by hand 14 times over 3 days"), the skills that ran and how often, the shell command prefixes run most by hand, the most common tool failures and the most common permission denials. Counts only, never raw events. Candidates the human rejected are left out. Read it before drafting a proposal. Pass since to count only from a date on, like when a change landed.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'Optional ISO date or time. The skill, command and failure counts then cover only events from it on; candidates still cover the 30 days.',
      },
    },
    additionalProperties: false,
  },
  isDeferred: true,
}

export const PROPOSAL_TOOL = {
  name: 'proposal',
  description:
    'Write Quartermaster proposals in .claude/quartermaster/proposals/. One operation per call. create drafts a proposal and allocates its id. update edits fields or moves status one rung along the ladder (draft, offered, applied, loaded, exercised, useful), or to expired when it went stale. decide records the human\'s answer: approve (accepted), reject with their reason (declined, never offered again), or later. record-change saves every file an accepted proposal will touch, once, before you edit them. rollback puts those files back (rolled-back), but only the ones still holding what the change wrote; a file edited since is left alone and named, and the proposal keeps its status. list shows proposals; with id it returns that one proposal in full, body, expect and baseline included. Subagents may only list. Illegal moves are refused with the moves that are allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['create', 'update', 'decide', 'record-change', 'rollback', 'list'],
        description: 'What to do. Every operation but create and list needs id.',
      },
      id: {
        type: 'string',
        description: 'The proposal, like P-0007. Not used by create, which allocates one. With list, reads that one proposal in full.',
      },
      kind: {
        type: 'string',
        enum: [...PROPOSAL_KINDS],
        description: 'create only: what sort of change this is.',
      },
      target: {
        type: 'string',
        description: 'create or update: the one thing it changes, on one line: a command prefix, a skill name, a file, a setting key.',
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'create or update: fingerprints of the candidates behind it, copied from the evidence tool (like script:npm run).',
      },
      expect: {
        type: 'string',
        description: 'create or update: a countable check that shows it helped, on one line ("hand runs of `npm run` per week").',
      },
      baseline: {
        type: 'number',
        description: 'create or update: the value of that check today, so a later count has something to beat.',
      },
      authority: {
        type: 'string',
        enum: [...AUTHORITIES],
        description: 'create only: quiet for a change inside Quartermaster\'s own files, ask for anything else. Defaults to ask.',
      },
      body: {
        type: 'string',
        description: 'create or update: markdown with what, why, the exact diff or command, and how to roll it back.',
      },
      status: {
        type: 'string',
        enum: [...PROPOSAL_STATUSES],
        description:
          'update: the status to move to; accepted and declined go through decide, rolled-back through rollback. list: only show proposals in this status.',
      },
      decision: {
        type: 'string',
        enum: ['approve', 'reject', 'later'],
        description: 'decide only: the human\'s answer. Record only what the human said, never your own call.',
      },
      reason: { type: 'string', description: 'decide with reject: the human\'s reason, in their words.' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'record-change only: every file the change will create or edit, relative to the project.',
      },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  isDeferred: true,
}
