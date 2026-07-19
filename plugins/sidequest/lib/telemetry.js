'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const OBSERVER_URL = 'http://127.0.0.1:14319/v1/observations';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const TIMEOUT_MS = 250;
let testSink = null;

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
}

function effort(value) {
  return typeof value === 'string' && EFFORTS.has(value) ? value : null;
}

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

function stableId(value) {
  return `sidequest_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function categoryId(ticket) {
  if (!ticket || ticket.category == null) return null;
  return identifier(ticket.categoryId || (typeof ticket.category === 'object' ? ticket.category.id : ticket.category));
}

function configuredRoute(ticket) {
  const route = ticket && ticket.category && typeof ticket.category === 'object' ? ticket.category.route : null;
  return route && typeof route === 'object' ? route : {};
}

function directLinks(ticket, dispatch) {
  const links = [];
  const add = (relation, toKind, toId) => {
    if (identifier(toId)) links.push({ relation, to_kind: toKind, to_id: toId, method: 'direct_id', quality: 'exact' });
  };
  add('routes_via', 'route', dispatch.id || ticket.dispatchId);
  add('belongs_to', 'task', dispatch.taskId || ticket.taskId);
  add('belongs_to', 'session', dispatch.sessionId || (ticket.claim && ticket.claim.sessionId));
  add('attributed_to', 'agent', dispatch.agentId);
  return links;
}

function ticketObservation(projectSlug, ticket) {
  if (!ticket || typeof ticket !== 'object') return null;
  const ticketRef = identifier(ticket.ref);
  const observedAt = ticket.updatedAt || ticket.createdAt;
  if (!ticketRef || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return null;

  const dispatch = ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : {};
  const route = configuredRoute(ticket);
  const exec = ticket.exec && typeof ticket.exec === 'object' ? ticket.exec : {};
  const attributes = {};
  assign(attributes, 'category', categoryId(ticket));
  assign(attributes, 'configured_model', identifier(route.model));
  assign(attributes, 'configured_effort', effort(route.effort));
  assign(attributes, 'configured_backend', identifier(route.backend || exec.backend));
  assign(attributes, 'resolved_model', identifier(ticket.model || exec.runsModel));
  assign(attributes, 'resolved_effort', effort(ticket.effort));
  assign(attributes, 'resolved_backend', identifier(exec.backend));
  assign(attributes, 'executor', identifier(dispatch.executor || ticket.dispatchExecutor || exec.agent));
  assign(attributes, 'dispatch_id', identifier(dispatch.id || ticket.dispatchId));
  assign(attributes, 'claim_worker_id', identifier(ticket.claim && ticket.claim.by));
  assign(attributes, 'claim_session_id', identifier(dispatch.sessionId || (ticket.claim && ticket.claim.sessionId)));
  assign(attributes, 'task_status', identifier(ticket.submission && !ticket.submission.integratedAt ? 'submitted' : ticket.status));

  const taskId = identifier(dispatch.taskId || ticket.taskId);
  const routeId = identifier(dispatch.id || ticket.dispatchId);
  const sessionId = identifier(dispatch.sessionId || (ticket.claim && ticket.claim.sessionId));
  const agentId = identifier(dispatch.agentId);
  const eventKey = {
    projectSlug: identifier(projectSlug),
    ticketRef,
    observedAt: new Date(observedAt).toISOString(),
    status: attributes.task_status || null,
    dispatchId: routeId,
    taskId,
    agentId,
    claimWorker: attributes.claim_worker_id || null,
  };
  const observation = {
    source: 'sidequest',
    source_event_id: stableId(eventKey),
    source_schema: 'native-v1',
    observed_at: eventKey.observedAt,
    event_name: 'sidequest.ticket',
    ticket_ref: ticketRef,
    attributes,
  };
  assign(observation, 'task_id', taskId);
  assign(observation, 'route_id', routeId);
  assign(observation, 'session_id', sessionId);
  assign(observation, 'agent_id', agentId);
  const links = directLinks(ticket, dispatch);
  if (links.length) observation.links = links;
  return observation;
}

function send(observation) {
  if (testSink) {
    try { testSink(observation); } catch (_) { /* telemetry must never affect board writes */ }
    return;
  }
  const body = JSON.stringify([observation]);
  const request = http.request(OBSERVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: TIMEOUT_MS,
  }, (response) => response.resume());
  request.on('timeout', () => request.destroy());
  request.on('error', () => {});
  request.end(body);
}

function emitTicket(projectSlug, ticket) {
  const observation = ticketObservation(projectSlug, ticket);
  if (observation) send(observation);
}

function setTestSink(sink) {
  testSink = typeof sink === 'function' ? sink : null;
}

module.exports = {
  emitTicket,
  setTestSink,
  ticketObservation,
};
