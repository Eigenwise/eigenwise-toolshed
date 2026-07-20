import crypto from 'node:crypto';
import http from 'node:http';

const OBSERVER_URL = 'http://127.0.0.1:14319/v1/observations';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const TIMEOUT_MS = 250;

type UnknownRecord = Record<string, unknown>;
type ObservationSink = (observation: TicketObservation) => void;

export interface ObservationLink {
  relation: string;
  to_kind: string;
  to_id: string;
  method: 'direct_id';
  quality: 'exact';
}

export interface TicketObservation {
  source: 'sidequest';
  source_event_id: string;
  source_schema: 'native-v1';
  observed_at: string;
  event_name: 'sidequest.ticket';
  ticket_ref: string;
  attributes: UnknownRecord;
  project_id?: string;
  task_id?: string;
  route_id?: string;
  session_id?: string;
  agent_id?: string;
  links?: ObservationLink[];
}

let testSink: ObservationSink | null = null;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
}

function effort(value: unknown): string | null {
  return typeof value === 'string' && EFFORTS.has(value) ? value : null;
}

function assign(target: UnknownRecord, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function stableId(value: unknown): string {
  return `sidequest_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function categoryId(ticket: UnknownRecord): string | null {
  if (ticket.category == null) return null;
  const category = ticket.category;
  const categoryValue = isRecord(category) ? category.id : category;
  return identifier(ticket.categoryId || categoryValue);
}

function configuredRoute(ticket: UnknownRecord): UnknownRecord {
  const category = ticket.category;
  const route = isRecord(category) ? category.route : null;
  return isRecord(route) ? route : {};
}

function directLinks(ticket: UnknownRecord, dispatch: UnknownRecord): ObservationLink[] {
  const links: ObservationLink[] = [];
  const add = (relation: string, toKind: string, toId: unknown): void => {
    const id = identifier(toId);
    if (id) links.push({ relation, to_kind: toKind, to_id: id, method: 'direct_id', quality: 'exact' });
  };
  const claim = isRecord(ticket.claim) ? ticket.claim : {};
  add('routes_via', 'route', dispatch.id || ticket.dispatchId);
  add('belongs_to', 'task', dispatch.taskId || ticket.taskId);
  add('belongs_to', 'session', dispatch.sessionId || claim.sessionId);
  add('attributed_to', 'agent', dispatch.agentId);
  return links;
}

function projectIdentity(project: unknown): { slug: string | null; projectId: string | null } {
  const projectRecord = isRecord(project) ? project : {};
  const slug = identifier(typeof project === 'string' ? project : projectRecord.slug);
  const projectPath = projectRecord.path;
  const projectId = typeof projectPath === 'string' && projectPath.length > 0
    ? crypto.createHash('sha256').update(projectPath).digest('hex')
    : null;
  return { slug, projectId };
}

export function ticketObservation(project: unknown, ticketValue: unknown): TicketObservation | null {
  if (!isRecord(ticketValue)) return null;
  const ticket = ticketValue;
  const { slug: projectSlug, projectId } = projectIdentity(project);
  const ticketRef = identifier(ticket.ref);
  const observedAt = ticket.updatedAt || ticket.createdAt;
  if (!ticketRef || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return null;

  const dispatch = isRecord(ticket.dispatch) ? ticket.dispatch : {};
  const route = configuredRoute(ticket);
  const exec = isRecord(ticket.exec) ? ticket.exec : {};
  const claim = isRecord(ticket.claim) ? ticket.claim : {};
  const submission = isRecord(ticket.submission) ? ticket.submission : null;
  const attributes: UnknownRecord = {};
  assign(attributes, 'category', categoryId(ticket));
  assign(attributes, 'configured_model', identifier(route.model));
  assign(attributes, 'configured_effort', effort(route.effort));
  assign(attributes, 'configured_backend', identifier(route.backend || exec.backend));
  assign(attributes, 'resolved_model', identifier(ticket.model || exec.runsModel));
  assign(attributes, 'resolved_effort', effort(ticket.effort));
  assign(attributes, 'resolved_backend', identifier(exec.backend));
  assign(attributes, 'executor', identifier(dispatch.executor || ticket.dispatchExecutor || exec.agent));
  assign(attributes, 'dispatch_id', identifier(dispatch.id || ticket.dispatchId));
  assign(attributes, 'claim_worker_id', identifier(claim.by));
  assign(attributes, 'claim_session_id', identifier(dispatch.sessionId || claim.sessionId));
  assign(attributes, 'task_status', identifier(submission && !submission.integratedAt ? 'submitted' : ticket.status));

  const taskId = identifier(dispatch.taskId || ticket.taskId);
  const routeId = identifier(dispatch.id || ticket.dispatchId);
  const sessionId = identifier(dispatch.sessionId || claim.sessionId);
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
  const observation: TicketObservation = {
    source: 'sidequest',
    source_event_id: stableId(eventKey),
    source_schema: 'native-v1',
    observed_at: eventKey.observedAt,
    event_name: 'sidequest.ticket',
    ticket_ref: ticketRef,
    attributes,
  };
  assign(observation as unknown as UnknownRecord, 'project_id', projectId);
  assign(observation as unknown as UnknownRecord, 'task_id', taskId);
  assign(observation as unknown as UnknownRecord, 'route_id', routeId);
  assign(observation as unknown as UnknownRecord, 'session_id', sessionId);
  assign(observation as unknown as UnknownRecord, 'agent_id', agentId);
  const links = directLinks(ticket, dispatch);
  if (links.length) observation.links = links;
  return observation;
}

function send(observation: TicketObservation): void {
  if (testSink) {
    try {
      testSink(observation);
    } catch {
      return;
    }
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

export function emitTicket(project: unknown, ticket: unknown): void {
  const observation = ticketObservation(project, ticket);
  if (observation) send(observation);
}

export function setTestSink(sink: unknown): void {
  testSink = typeof sink === 'function' ? sink as ObservationSink : null;
}
