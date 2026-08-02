'use strict';

const {
  store,
  resolveProject,
  PROJECT_PROP,
  mutationAck,
  PAGE_LIMIT_MAX,
  compactComment,
  preservesFinalReport,
  pageRows,
} = require('./mcp-shared');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};

const tools: ToolDefinition[] = [
  {
    name: 'comment',
    description: 'Add a durable handoff comment (decisions, constraints, risks, evidence); not progress narration.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP, body: { type: 'string' }, by: { type: 'string' } },
      required: ['ref', 'body'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const res = store.addComment(slug, args.ref, { body: args.body, by: args.by || 'agent', kind: 'comment', source: 'mcp' });
      return mutationAck(slug, res, res.ok ? { commentId: res.comment.id, at: res.comment.at } : null);
    },
  },
  {
    name: 'comments',
    description: 'Read ticket comments before work; full history is chronological. Past 10 comments, oldest bodies are omitted unless full:true. Follow nextCursor when paging.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        full: { type: 'boolean', description: 'Recovery read: whole bodies, uncapped, bypasses elision. Default reads return capped excerpts (1200 chars/body) with full metadata; use defaults for closeout and status reads.' },
        cursor: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
        limit: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT_MAX },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const t = store.getTicket(slug, args.ref);
      if (!t) throw new Error(`comments: no ticket "${args.ref}".`);
      const full = !!args.full;
      const history = store.commentHistory(t.comments || [], full);
      const comments = full ? history.comments : history.comments.map((comment: any) => compactComment(comment, preservesFinalReport(t, comment)));
      const buildPayload = (page: any[], total: number, nextCursor: string | null) => {
        const payload: any = {
          ref: t.ref,
          comments: page,
          total,
          returned: page.length,
          nextCursor,
          order: 'chronological',
        };
        if (history.omittedBodies) Object.assign(payload, { omittedBodies: history.omittedBodies, notice: history.notice });
        return payload;
      };
      const explicitlyPaged = args.cursor != null || args.limit != null;
      if (explicitlyPaged) return pageRows(comments, args, 'comments', buildPayload, null);
      if (full) return { ref: t.ref, comments };
      return buildPayload(comments, comments.length, null);
    },
  },
  {
    name: 'link',
    description: 'Relate two tickets (the inverse is written automatically). verb: blocks | depends-on | related. A ticket blocked by an unfinished one is skipped by ready/next.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        verb: { type: 'string', enum: ['blocks', 'depends-on', 'related'] },
        to: { type: 'string' },
        project: PROJECT_PROP,
      },
      required: ['from', 'verb', 'to'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const res = store.linkTickets(slug, args.from, args.verb, args.to);
      if (!res.ok) throw new Error(`link: ${res.reason}`);
      return { ok: true, project: slug, from: res.from.ref, to: res.to.ref, type: res.type };
    },
  },
  {
    name: 'unlink',
    description: 'Remove every link between two tickets (both directions).',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, project: PROJECT_PROP },
      required: ['a', 'b'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const res = store.unlinkTickets(slug, args.a, args.b);
      if (!res.ok) throw new Error(`unlink: ${res.reason}`);
      return { ok: true, project: slug, a: args.a, b: args.b };
    },
  },
  {
    name: 'assign',
    description: 'Set a ticket\'s persistent assignee (defaults to "you", the human) — separate from an agent claim. Pass to:"none" or use unassign to clear.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, to: { type: 'string' }, project: PROJECT_PROP },
      required: ['ref'],
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const who = args.to == null ? 'you' : (String(args.to).toLowerCase() === 'none' ? null : args.to);
      const res = store.assignTicket(slug, args.ref, who, { source: 'mcp' });
      if (!res.ok) throw new Error(`assign: no ticket "${args.ref}".`);
      return mutationAck(slug, res, { assignee: res.ticket.assignee });
    },
  },
];

module.exports = { tools };
