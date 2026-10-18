import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-refs-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-refs-project-'));
process.env.CLAUDE_PROJECT_DIR = project;
const store = require('../lib/store');
const slug = store.ensureProject(project).slug;
execFileSync('git', ['init', '-b', 'main', project], { stdio: 'pipe' });
execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repository.git'], { cwd: project });

const mcp = require('../lib/mcp');
const agentsync = require('../lib/agentsync');
const work = require('../lib/work');

test('MCP add and update round trip refs and compact reads omit URLs', async () => {
  const add = mcp.TOOLS.find((tool: { name: string }) => tool.name === 'add');
  const update = mcp.TOOLS.find((tool: { name: string }) => tool.name === 'update');
  assert.ok(add.inputSchema.properties.refs, 'MCP add accepts external refs');
  assert.equal(add.inputSchema.properties.refs.items.type, 'string');
  assert.equal(update.inputSchema.properties.refs.items.type, 'string');
  const added = await add.handler({ project, title: 'MCP refs', unclassified: true, refs: ['GH-123'] });
  const ticket = store.listTickets(slug)[0];
  assert.equal(added.ok, true);
  assert.deepEqual(ticket.externalRefs, [{ key: 'GH-123', url: 'https://github.com/owner/repository/issues/123' }]);
  await update.handler({ project, ref: ticket.ref, refs: ['https://github.com/owner/repository/pull/456'] });
  const updated = store.getTicket(slug, ticket.ref);
  assert.deepEqual(updated.externalRefs, [{ key: 'GH-456', url: 'https://github.com/owner/repository/pull/456' }]);
  const brief = store.listPayload(slug, { brief: true }).tickets[0];
  assert.deepEqual(brief.refs, ['GH-456']);
  assert.doesNotMatch(JSON.stringify(brief), /github.com/);
  assert.deepEqual(store.listPayload(slug, {}).tickets[0].externalRefs, updated.externalRefs);
  assert.deepEqual(store.pulsePayload(slug, ticket.ref).refs, ['GH-456']);
  const pulseTool = mcp.TOOLS.find((tool: { name: string }) => tool.name === 'pulse');
  assert.deepEqual((await pulseTool.handler({ project, ref: ticket.ref })).refs, ['GH-456']);
  assert.match(agentsync.renderTicketBriefing(updated, 'nonce', slug, project), /Refs: GH-456/);
  assert.match(work.executorPrompt(updated, 'Work ticket'), /Refs: GH-456/);
  await update.handler({ project, ref: ticket.ref, refs: [] });
  assert.deepEqual(store.getTicket(slug, ticket.ref).externalRefs, []);
});
