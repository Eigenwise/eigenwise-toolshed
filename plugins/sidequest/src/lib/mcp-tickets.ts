'use strict';

const {
  store,
  resolveProject,
  sessionOf,
  PROJECT_PROP,
  FILES_PROP,
  LABELS_PROP,
  validateStoryId,
  mutationAck,
  requiredText,
} = require('./mcp-shared');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};

const tools: ToolDefinition[] = [
  {
    name: 'add',
    description: 'File a ticket on the board. description is a developer-to-developer note, passed as a normal string (real newlines fine — no shell escaping). Use this to capture work the user mentions in passing so it outlives the session.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        labels: LABELS_PROP,
        files: FILES_PROP,
        storyId: { type: 'string', pattern: String.raw`^US-\d+$`, description: 'A story ref (US-n) to file this ticket into.' },
      },
      required: ['title'],
    },
    handler(args) {
      if (!args.title || !String(args.title).trim()) throw new Error('add: title is required.');
      const { slug } = resolveProject(args.project);
      if (args.storyId !== undefined) validateStoryId(args.storyId);
      const created = store.createTicket(slug, {
        title: args.title,
        description: args.description || '',
        priority: args.priority,
        status: args.status,
        labels: args.labels,
        files: args.files,
        storyId: args.storyId,
        source: 'mcp',
      });
      const ticket = store.getTicket(slug, created.ref) || created;
      return mutationAck(slug, { ok: true, ticket });
    },
  },
  {
    name: 'update',
    description: 'Edit a ticket in place: title, description, priority, status, labels, declared files, or the story it belongs to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        ref: { type: 'string' },
        by: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: store.VALID_PRIORITY },
        status: { type: 'string', enum: store.VALID_STATUS },
        labels: LABELS_PROP,
        files: FILES_PROP,
        storyId: { type: 'string', description: 'A story ref (US-n), or "none" to unfile.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const patch: any = { source: 'mcp', sessionId: sessionOf(args) };
      if (args.by !== undefined) patch.by = args.by;
      for (const k of ['title', 'description', 'priority', 'status', 'labels', 'files']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.storyId !== undefined) {
        validateStoryId(args.storyId, true);
        patch.storyId = args.storyId;
      }
      const updated = store.updateTicket(slug, args.ref, patch);
      if (!updated) throw new Error(`update: no ticket "${args.ref}" on ${meta.name}.`);
      const t = store.getTicket(slug, updated.ref) || updated;
      return mutationAck(slug, { ok: true, ticket: t });
    },
  },
  {
    name: 'remove',
    description: 'Permanently and irreversibly delete a ticket by ref. Refuses a live claim unless force:true is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        force: { type: 'boolean', description: 'Permanently remove a ticket with a live claim. Use only when certain.' },
      },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = store.getTicket(slug, args.ref);
      if (!ticket) throw new Error(`remove: no ticket "${args.ref}" on ${meta.name}.`);
      const ref = ticket.ref;
      if (!store.deleteTicket(slug, ticket.id)) {
        throw new Error(`remove: could not delete "${ticket.ref}" from ${meta.name}.`);
      }
      return { ok: true, ref };
    },
  },
  {
    name: 'archive',
    description: 'Archive one ticket by ref, or every done ticket with done:true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        project: PROJECT_PROP,
        done: { type: 'boolean', description: 'Archive every done ticket on the board.' },
      },
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      if (args.done) {
        const result = store.archiveAllDone(slug, { source: 'mcp' });
        return { ok: result.ok, archived: result.archived.length };
      }
      const ref = requiredText(args, 'ref', 'archive');
      const result = store.archiveTicket(slug, ref, { source: 'mcp' });
      if (!result.ok) throw new Error(`archive: no ticket "${ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    },
  },
  {
    name: 'unarchive',
    description: 'Restore an archived ticket by ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, project: PROJECT_PROP },
      required: ['ref'],
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const result = store.unarchiveTicket(slug, args.ref, { source: 'mcp' });
      if (!result.ok) throw new Error(`unarchive: no ticket "${args.ref}" on ${meta.name}.`);
      return mutationAck(slug, result);
    },
  },
];

module.exports = { tools };
