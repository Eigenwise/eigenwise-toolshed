'use strict';
import type { IntakeInput } from './store/intake.js';
const { store, resolveProject, PROJECT_PROP } = require('./mcp-shared');

const tools = [{
  name: 'story_intake',
  description: 'Record intake once before implementation. Approval records caller-supplied requester/delegate identity, not authentication. delegate.by names the delegate; namedBy must be the requester. question adds; answer records an answer. reopen clears approval. exempt needs a 20-character size/reversibility/stakes reason.',
  inputSchema: {
    type: 'object',
    properties: {
      project: PROJECT_PROP,
      action: { type: 'string', enum: ['playback', 'sizing', 'question', 'answer', 'cycle', 'approve', 'delegate', 'reopen', 'exempt'] },
      story: { type: 'string' }, ref: { type: 'string' }, by: { type: 'string' }, namedBy: { type: 'string' },
      text: { type: 'string' }, size: { type: 'string', enum: ['one-ticket', 'one-wave', 'multi-wave'] }, reason: { type: 'string' },
      options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, reason: { type: 'string' }, recommended: { const: true } }, required: ['label', 'reason'] } },
      id: { type: 'string' }, answer: { type: 'string' }, assumption: { type: 'boolean' }, review: { type: 'string' }, findings: { type: 'string' }, research: { type: 'array', items: { type: 'string' } },
    },
    required: ['action', 'by'],
  },
  handler(args: IntakeInput & { project?: string }) {
    const { slug } = resolveProject(args.project);
    return { ok: true, project: slug, result: store.storyIntake(slug, args) };
  },
}];
module.exports = { tools };
