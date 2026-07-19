'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function readCursor(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.serverTime === 'string' && Number.isFinite(Date.parse(parsed.serverTime))
      ? parsed.serverTime
      : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeCursor(file, serverTime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ serverTime }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function defaultChangesRunner({ sidequestBin, project, since }) {
  const args = [sidequestBin, 'changes', '--since', since, '--project', project, '--json'];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
}

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function effort(value) {
  return typeof value === 'string' && EFFORTS.has(value) ? value : null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

function sourceEventId(ticket, safeEvidence) {
  const discriminator = first(ticket.updatedAt, ticket.updated_at, ticket.sequence, ticket.lastEventId, 'snapshot');
  const digest = createHash('sha256')
    .update(JSON.stringify([safeEvidence, discriminator]))
    .digest('hex');
  return `sidequest_${digest}`;
}

function ticketObservation(ticket, options) {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return null;
  const ticketRef = identifier(first(ticket.ref, ticket.ticket_ref));
  const observedAt = first(ticket.updatedAt, ticket.updated_at);
  if (!ticketRef || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return null;

  const configured = ticket.configured && typeof ticket.configured === 'object' ? ticket.configured : {};
  const resolved = ticket.resolved && typeof ticket.resolved === 'object' ? ticket.resolved : {};
  const runtime = ticket.runtime && typeof ticket.runtime === 'object' ? ticket.runtime : {};
  const dispatch = ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : {};
  const claim = ticket.claim && typeof ticket.claim === 'object' ? ticket.claim : {};
  const attributes = {};

  assign(attributes, 'category', identifier(first(ticket.categoryId, ticket.category, ticket.category_id)));
  assign(attributes, 'configured_model', identifier(first(ticket.configuredModel, ticket.configured_model, configured.model, ticket.model)));
  assign(attributes, 'configured_effort', effort(first(ticket.configuredEffort, ticket.configured_effort, configured.effort, ticket.effort)));
  assign(attributes, 'configured_backend', identifier(first(ticket.configuredBackend, ticket.configured_backend, configured.backend, ticket.backend)));
  assign(attributes, 'resolved_model', identifier(first(ticket.resolvedModel, ticket.resolved_model, resolved.model, runtime.model, ticket.runsModel)));
  assign(attributes, 'resolved_effort', effort(first(ticket.resolvedEffort, ticket.resolved_effort, resolved.effort, runtime.effort, ticket.effort)));
  assign(attributes, 'resolved_backend', identifier(first(ticket.resolvedBackend, ticket.resolved_backend, resolved.backend, runtime.backend, ticket.backend)));
  assign(attributes, 'executor', identifier(first(ticket.resolvedExecutor, ticket.resolved_executor, resolved.executor, runtime.executor, ticket.executor)));
  assign(attributes, 'dispatch_id', identifier(first(ticket.dispatchId, ticket.dispatch_id, dispatch.id)));
  assign(attributes, 'claim_worker_id', identifier(first(claim.by, claim.worker, claim.workerId, claim.worker_id)));
  assign(attributes, 'claim_session_id', identifier(first(claim.session, claim.sessionId, claim.session_id)));
  assign(attributes, 'task_status', identifier(ticket.status));

  const taskId = identifier(first(ticket.taskId, ticket.task_id, dispatch.taskId, dispatch.task_id));
  const dispatchId = attributes.dispatch_id || null;
  const safeEvidence = { ticketRef, taskId, dispatchId, attributes };
  const observation = {
    source: 'sidequest',
    source_event_id: sourceEventId(ticket, safeEvidence),
    source_schema: 'changes-v1',
    observed_at: new Date(observedAt).toISOString(),
    event_name: 'sidequest.ticket',
    ticket_ref: ticketRef,
    attributes,
  };
  assign(observation, 'project_id', options.projectId);
  assign(observation, 'task_id', taskId);
  assign(observation, 'route_id', dispatchId);

  const storyRef = identifier(first(
    ticket.storyRef,
    ticket.story_ref,
    typeof ticket.story === 'string' ? ticket.story : ticket.story?.ref,
  ));
  if (storyRef) {
    observation.links = [{
      relation: 'belongs_to',
      to_kind: 'ticket',
      to_id: storyRef,
      method: 'application_supplied',
      quality: 'exact',
    }];
  }
  return observation;
}

async function captureSidequestChanges(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Sidequest adapter options are required.');
  if (typeof options.cursorPath !== 'string') throw new TypeError('cursorPath is required.');
  if (typeof options.ingest !== 'function') throw new TypeError('ingest is required.');

  const since = readCursor(options.cursorPath) || options.initialSince;
  if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) {
    throw new TypeError('initialSince must be an ISO timestamp when no cursor exists.');
  }
  const runChanges = options.runChanges || ((input) => defaultChangesRunner({
    ...input,
    sidequestBin: options.sidequestBin,
    project: options.project,
  }));
  const response = await runChanges({ since });
  if (!response || typeof response !== 'object' || !Array.isArray(response.tickets)) {
    throw new Error('Sidequest changes returned an invalid response.');
  }
  if (typeof response.serverTime !== 'string' || !Number.isFinite(Date.parse(response.serverTime))) {
    throw new Error('Sidequest changes omitted a valid serverTime cursor.');
  }

  let accepted = 0;
  let skipped = 0;
  for (const ticket of response.tickets) {
    const observation = ticketObservation(ticket, options);
    if (!observation) {
      skipped += 1;
      continue;
    }
    await options.ingest(observation);
    accepted += 1;
  }
  writeCursor(options.cursorPath, new Date(response.serverTime).toISOString());
  return { accepted, skipped, serverTime: new Date(response.serverTime).toISOString() };
}

module.exports = {
  captureSidequestChanges,
  readCursor,
  ticketObservation,
};
